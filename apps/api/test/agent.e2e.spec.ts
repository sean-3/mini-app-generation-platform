import { DatabaseService } from '../src/persistence/database.service';
import { TemplatesService } from '../src/templates/templates.service';
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service';
import { ToolGatewayService } from '../src/tool-gateway/tool-gateway.service';
import { EvalService } from '../src/eval/eval.service';
import { RunEventHub } from '../src/agent/run-hub';
import { AgentService } from '../src/agent/agent.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function waitFor(fn: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out waiting for condition');
}

describe('AgentService end-to-end (real DeepAgents loop)', () => {
  let dir: string;
  let agent: AgentService;
  let db: DatabaseService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-'));
    process.env.DATA_DIR = dir;
    db = new DatabaseService();
    db.onModuleInit();
    const templates = new TemplatesService();
    agent = new AgentService(
      db,
      templates,
      new ModelGatewayService(templates),
      new ToolGatewayService(),
      new EvalService(db),
      new RunEventHub(),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('full run: input -> architecture approval -> publish approval -> published + eval', async () => {
    const run = agent.createRun('小区团购接龙');
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_architecture');
    const afterA = agent.getRun(run.id);
    expect(afterA.template_id).toBe('signup');
    expect(JSON.parse(afterA.requirements_json ?? '{}').requirements?.length).toBeGreaterThan(0);
    expect(JSON.parse(afterA.architecture_json ?? '{}').storage).toBeDefined();

    agent.approveArchitecture(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_publish');
    const afterB = agent.getRun(run.id);
    const draft = JSON.parse(afterB.draft_json ?? '{}');
    expect(draft.templateId).toBe('signup');
    expect(draft.valid ?? draft.alex?.valid).toBe(true);

    agent.approvePublish(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'published');
    const done = agent.getRun(run.id);
    expect(done.app_id).toBeTruthy();
    const app = db.get<{ template_id: string }>('SELECT template_id FROM apps WHERE id = ?', done.app_id!);
    expect(app?.template_id).toBe('signup');

    // Tina + David run async after publish; eval lands shortly after.
    await waitFor(() => agent.getReplay(run.id).eval !== null);
    const replay = agent.getReplay(run.id);
    expect(replay.traces.length).toBeGreaterThan(5);
    expect(replay.eval!.toolCalls).toBeGreaterThan(0);
    expect(replay.eval!.successRate).toBeGreaterThan(0.5);
  }, 60_000);

  it('architecture rejection rolls back', async () => {
    const run = agent.createRun('记账看板');
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_architecture');
    agent.approveArchitecture(run.id, false);
    expect(agent.getRun(run.id).status).toBe('rolled_back');
  }, 60_000);

  it('no template match stops with guidance, no pipeline', async () => {
    const run = agent.createRun('在线商城');
    expect(agent.getRun(run.id).status).toBe('stopped');
    const traces = db.query<{ result_json: string }>("SELECT result_json FROM traces WHERE run_id = ? AND kind = 'stage'", run.id);
    expect(traces[0]?.result_json).toContain('未匹配');
  });

  it('repeat demo: gateway blocks the 3rd identical call and stops the run', async () => {
    const run = agent.repeatDemo('团购接龙');
    await waitFor(() => agent.getRun(run.id).status === 'stopped');
    const blocked = db.query<{ result_json: string }>(
      "SELECT result_json FROM traces WHERE run_id = ? AND is_error = 1",
      run.id,
    );
    expect(blocked.some((t) => t.result_json.includes('repeat_call'))).toBe(true);
  }, 60_000);
});
