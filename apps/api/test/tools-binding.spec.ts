import { DatabaseService } from '../src/persistence/database.service';
import { TemplatesService } from '../src/templates/templates.service';
import { EvalService } from '../src/eval/eval.service';
import { buildTools } from '../src/agent/tools';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 回归：线上实测 run 5bb54c6d（2026-11-23）里 compute_eval 的 runId 是模型传进来的，
 * 模型不知道当前 run 的 id，传错后 eval 写到了错误的 runId 下，回放页 eval 一直是 null。
 * runId / appId 必须服务端绑定，模型传什么都不采用。
 */
describe('tools: server-side binding of runId / appId', () => {
  let dir: string;
  let db: DatabaseService;
  let templates: TemplatesService;
  let evalService: EvalService;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-binding-test-'));
    process.env.DATA_DIR = dir;
    db = new DatabaseService();
    db.onModuleInit();
    templates = new TemplatesService();
    evalService = new EvalService(db);
    const now = new Date().toISOString();
    // 正确 run 下 3 条 ok 的 tool trace。
    for (let i = 1; i <= 3; i++) {
      db.run(
        'INSERT INTO traces (run_id, seq, actor, kind, tool, result_json, is_error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'run-correct',
        i,
        'ToolGateway',
        'tool',
        'match_template',
        '{}',
        0,
        100,
        now,
      );
    }
    // 正确应用：signup 模板 + 种子数据。
    db.run(
      'INSERT INTO apps (id, name, template_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      'app-correct',
      '接龙测试',
      'signup',
      JSON.stringify(templates.seedData('signup')),
      now,
      now,
    );
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compute_eval ignores the model-supplied runId and writes the eval under the bound run', async () => {
    const tools = buildTools({ db, templates, evalService, runId: 'run-correct' });
    // 模拟线上实测：模型编了一个它不知道的 runId。
    const out = await tools.computeEval.invoke({ runId: 'run-wrong' } as never);
    const e = JSON.parse(out as string);
    expect(e.runId).toBe('run-correct');
    expect(e.toolCalls).toBe(3);
    expect(evalService.latest('run-correct')).not.toBeNull();
    expect(evalService.latest('run-wrong')).toBeNull();
  });

  it('run_smoke_tests ignores the model-supplied appId when one is bound', async () => {
    const tools = buildTools({ db, templates, evalService, runId: 'run-correct', appId: 'app-correct' });
    const out = await tools.runSmokeTests.invoke({ appId: 'app-wrong' } as never);
    expect(JSON.parse(out as string).passed).toBe(true);
  });

  it('run_smoke_tests still accepts a model-supplied appId when none is bound', async () => {
    const tools = buildTools({ db, templates, evalService, runId: 'run-correct' });
    const out = await tools.runSmokeTests.invoke({ appId: 'app-correct' });
    expect(JSON.parse(out as string).passed).toBe(true);
  });
});
