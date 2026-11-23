import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../src/persistence/database.service';
import { TemplatesService } from '../src/templates/templates.service';
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service';
import { DeterministicModel } from '../src/model-gateway/deterministic-model';
import { buildDeterministicScript } from '../src/model-gateway/deterministic-scripts';
import { ToolGatewayService } from '../src/tool-gateway/tool-gateway.service';
import { AppsService } from '../src/apps/apps.service';

function makeApps(factory?: (phase: string, ctx: Record<string, unknown>) => any): { apps: AppsService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-edit-'));
  process.env.DATA_DIR = dir;
  delete process.env.MOONSHOT_API_KEY;
  const db = new DatabaseService();
  db.onModuleInit();
  const templates = new TemplatesService();
  const mg = new ModelGatewayService(
    templates,
    factory ?? ((phase, ctx) => new DeterministicModel(buildDeterministicScript(phase, ctx as any))),
  );
  const apps = new AppsService(db, templates, new ToolGatewayService(), mg);
  return { apps, dir };
}

describe('AppsService.editData (dialogue edit, data-only)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('signup: “加一条报名” appends one signup, workspace only', async () => {
    const { apps, dir: d } = makeApps();
    dir = d;
    const app = apps.create('signup', '团购接龙');
    const { app: updated, changes } = await apps.editData(app.id, '加一条报名');
    const data = JSON.parse(updated.data_json);
    expect(data.signups.length).toBe(7);
    expect(data.signups[6].name).toBe('新报名');
    expect(changes).toEqual([{ key: 'signups', kind: 'changed', summary: 'signups：6 条 → 7 条' }]);
    // 只改工作区：从未发布，线上快照仍为空。
    expect(updated.published_json).toBeNull();
    expect(updated.published_version).toBe(0);
  });

  it('ledger: “加一笔 250 元餐饮” appends a record with the amount from input', async () => {
    const { apps, dir: d } = makeApps();
    dir = d;
    const app = apps.create('ledger', '记账');
    const { app: updated } = await apps.editData(app.id, '加一笔 250 元餐饮');
    const data = JSON.parse(updated.data_json);
    expect(data.records.length).toBe(9);
    expect(data.records[8].amount).toBe(250);
  });

  it('signup: “删最后一条报名” removes the last signup', async () => {
    const { apps, dir: d } = makeApps();
    dir = d;
    const app = apps.create('signup', '团购接龙');
    const { app: updated, changes } = await apps.editData(app.id, '删最后一条报名');
    expect(JSON.parse(updated.data_json).signups.length).toBe(5);
    expect(changes[0].summary).toBe('signups：6 条 → 5 条');
  });

  it('model returns non-JSON: 400, nothing saved', async () => {
    const { apps, dir: d } = makeApps(() => new DeterministicModel([{ type: 'text', text: '这不是 JSON' }]));
    dir = d;
    const app = apps.create('signup', '团购接龙');
    await expect(apps.editData(app.id, '加一条报名')).rejects.toThrow(/没有返回有效的新数据/);
    expect(JSON.parse(apps.get(app.id).data_json).signups.length).toBe(6);
  });

  it('model returns schema-invalid data: 400, nothing saved', async () => {
    const { apps, dir: d } = makeApps(() =>
      new DeterministicModel([{ type: 'text', text: JSON.stringify({ signups: [{ id: 'x', name: 'a', count: '不是数字' }] }) }]),
    );
    dir = d;
    const app = apps.create('signup', '团购接龙');
    await expect(apps.editData(app.id, '加一条报名')).rejects.toThrow(/不合法/);
    expect(JSON.parse(apps.get(app.id).data_json).signups.length).toBe(6);
  });

  it('unknown app: 404', async () => {
    const { apps, dir: d } = makeApps();
    dir = d;
    await expect(apps.editData('no-such-app', '加一条报名')).rejects.toThrow(/not found/);
  });
});
