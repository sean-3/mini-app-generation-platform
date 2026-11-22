import { DatabaseService } from '../src/persistence/database.service';
import { TemplatesService } from '../src/templates/templates.service';
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service';
import { DeterministicModel } from '../src/model-gateway/deterministic-model';
import { buildDeterministicScript } from '../src/model-gateway/deterministic-scripts';
import { ToolGatewayService } from '../src/tool-gateway/tool-gateway.service';
import { EvalService } from '../src/eval/eval.service';
import { RunEventHub } from '../src/agent/run-hub';
import { AgentService } from '../src/agent/agent.service';
import { AppsService } from '../src/apps/apps.service';
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
    // 单测不用真 key：确定性模型走测试工厂，跑同一套阶段代码。
    delete process.env.MOONSHOT_API_KEY;
    db = new DatabaseService();
    db.onModuleInit();
    const templates = new TemplatesService();
    agent = new AgentService(
      db,
      templates,
      new ModelGatewayService(templates, (phase, ctx) => new DeterministicModel(buildDeterministicScript(phase, ctx as any))),
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

    // 冒烟 + 评估在发布后异步跑，eval 随后落库。
    await waitFor(() => agent.getReplay(run.id).eval !== null);
    const replay = agent.getReplay(run.id);
    expect(replay.traces.length).toBeGreaterThan(5);
    expect(replay.eval!.toolCalls).toBeGreaterThan(0);
    expect(replay.eval!.successRate).toBeGreaterThan(0.5);
  }, 60_000);

  it('usage is recorded after each model call, not only at stage end', async () => {
    // 线上实测 run df4df137 卡在 Stage B 四分钟，usage 还是空的——之前只在
    // 阶段结束时算一次。现在每次模型调用返回后中间件立刻累计，卡住也能看到烧了多少。
    const run = agent.createRun('小区团购接龙');
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_architecture');
    const usage = JSON.parse(agent.getRun(run.id).usage_json ?? '{}');
    expect(usage.modelCalls).toBeGreaterThan(0);
    expect(usage.totalTokens).toBeGreaterThan(0);
    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
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

  it('plan mode: plan approval gate, then full flow to published', async () => {
    const run = agent.createRun('记账看板', { mode: 'plan', teamMode: true });
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_plan');
    const plan = JSON.parse(agent.getRun(run.id).plan_json ?? '{}');
    expect(plan.templateId).toBe('ledger');
    expect(plan.team).toContain('Bob');
    expect(plan.approvals).toEqual(['计划', '架构', '发布']);

    agent.approvePlan(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_architecture');
    agent.approveArchitecture(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_publish');
    agent.approvePublish(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'published');
    const done = agent.getRun(run.id);
    const app = db.get<{ published_version: number; published_json: string }>(
      'SELECT published_version, published_json FROM apps WHERE id = ?',
      done.app_id!,
    );
    expect(app?.published_version).toBe(1);
    expect(app?.published_json).toBeTruthy();
  }, 60_000);

  it('plan rejection rolls back', async () => {
    const run = agent.createRun('记账看板', { mode: 'plan' });
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_plan');
    agent.approvePlan(run.id, false);
    expect(agent.getRun(run.id).status).toBe('rolled_back');
  }, 60_000);

  it('team mode on: 5-person flow, no other role names in traces', async () => {
    const run = agent.createRun('习惯打卡', { mode: 'build', teamMode: true });
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_architecture');
    const afterA = agent.getRun(run.id);
    // 设计是 Bob 架构输出的一部分，不再有独立的设计角色。
    expect(JSON.parse(afterA.architecture_json ?? '{}').design?.layout).toBeTruthy();
    agent.approveArchitecture(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_publish');
    agent.approvePublish(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'published');
    await waitFor(() => agent.getReplay(run.id).eval !== null);
    const actors = db.query<{ actor: string }>('SELECT DISTINCT actor FROM traces WHERE run_id = ?', run.id).map((r) => r.actor.toLowerCase());
    for (const banned of ['nora', 'tina', 'oscar', 'david']) {
      expect(actors).not.toContain(banned);
    }
  }, 60_000);

  it('engineer mode: Alex alone, draft ready at architecture approval, skips stage B', async () => {
    const run = agent.createRun('报价计算器', { mode: 'engineer' });
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_architecture');
    const afterA = agent.getRun(run.id);
    expect(afterA.team_mode).toBe(0);
    expect(JSON.parse(afterA.draft_json ?? '{}').templateId).toBe('quote');
    agent.approveArchitecture(run.id, true);
    // 草稿已在，跳过 Stage B，直接等发布审批。
    expect(agent.getRun(run.id).status).toBe('awaiting_publish');
    agent.approvePublish(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'published');
  }, 60_000);

  it('publish/update: edit after publish does not touch the live snapshot until Update', async () => {
    const apps = new AppsService(db, new TemplatesService(), new ToolGatewayService());
    const run = agent.createRun('小区团购接龙');
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_architecture');
    agent.approveArchitecture(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'awaiting_publish');
    agent.approvePublish(run.id, true);
    await waitFor(() => agent.getRun(run.id).status === 'published');
    const appId = agent.getRun(run.id).app_id!;
    const v1 = apps.get(appId);
    expect(v1.published_version).toBe(1);
    expect(v1.published_json).toBe(v1.data_json);

    // 改数据：只动工作区，线上快照不动。
    const data = JSON.parse(v1.data_json);
    data.signups.push({ id: 's99', name: '测试', count: 1, note: '' });
    const edited = apps.updateData(appId, data);
    expect(JSON.parse(edited.data_json).signups.length).toBe(7);
    expect(edited.published_json).toBe(v1.published_json);
    expect(edited.published_version).toBe(1);

    // Update：线上版更新，版本号 +1。
    const v2 = apps.publishUpdate(appId);
    expect(v2.published_version).toBe(2);
    expect(v2.published_json).toBe(v2.data_json);
    expect(JSON.parse(v2.published_json).signups.length).toBe(7);
  }, 60_000);

  it('no key: createRun throws a clear MOONSHOT_API_KEY error and never starts a run', () => {
    delete process.env.MOONSHOT_API_KEY;
    const templates = new TemplatesService();
    // 生产装配：不传测试工厂，没有 key 就不能建 run，绝不用假模型冒充。
    const prodAgent = new AgentService(
      db,
      templates,
      new ModelGatewayService(templates),
      new ToolGatewayService(),
      new EvalService(db),
      new RunEventHub(),
    );
    expect(() => prodAgent.createRun('小区团购接龙')).toThrow(/MOONSHOT_API_KEY/);
    expect(db.query('SELECT * FROM runs')).toHaveLength(0);
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
