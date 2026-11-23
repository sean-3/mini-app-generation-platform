import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../src/persistence/database.service';
import { TemplatesService } from '../src/templates/templates.service';
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service';
import { ToolGatewayService } from '../src/tool-gateway/tool-gateway.service';
import { AppsService } from '../src/apps/apps.service';

describe('AppsService versions + restore', () => {
  let dir: string;
  let apps: AppsService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-restore-'));
    process.env.DATA_DIR = dir;
    const db = new DatabaseService();
    db.onModuleInit();
    const templates = new TemplatesService();
    apps = new AppsService(db, templates, new ToolGatewayService(), new ModelGatewayService(templates));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('each Publish/Update writes a snapshot row; restore brings back v1 data without touching the live snapshot', () => {
    const app = apps.create('signup', '团购接龙');
    expect(apps.listVersions(app.id)).toEqual([]);

    apps.publishUpdate(app.id); // v1: 6 signups
    const v1 = JSON.parse(apps.get(app.id).data_json);
    expect(v1.signups.length).toBe(6);

    // 改工作区数据，再发布 v2。
    const data2 = JSON.parse(apps.get(app.id).data_json);
    data2.signups.push({ id: 's7', name: '新报名', count: 1, note: '', building: '', slot: '上午 09:00-11:00', phone: '', items: '' });
    apps.updateData(app.id, data2);
    apps.publishUpdate(app.id); // v2: 7 signups

    const versions = apps.listVersions(app.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    // 恢复到 v1：工作区回到 6 条，线上快照仍是 v2 的 7 条。
    const restored = apps.restore(app.id, 1);
    expect(JSON.parse(restored.data_json).signups.length).toBe(6);
    expect(JSON.parse(restored.published_json!).signups.length).toBe(7);
    expect(restored.published_version).toBe(2);

    // 再点 Update，线上版变成 v3（6 条）。
    const v3 = apps.publishUpdate(app.id);
    expect(v3.published_version).toBe(3);
    expect(JSON.parse(v3.published_json!).signups.length).toBe(6);
    expect(apps.listVersions(app.id).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('restore of a nonexistent version: 400', () => {
    const app = apps.create('signup', '团购接龙');
    apps.publishUpdate(app.id);
    expect(() => apps.restore(app.id, 99)).toThrow(/版本 v99 不存在/);
    // 数据没动。
    expect(JSON.parse(apps.get(app.id).data_json).signups.length).toBe(6);
  });

  it('restore of an unknown app: 404', () => {
    expect(() => apps.restore('no-such-app', 1)).toThrow(/not found/);
    expect(() => apps.listVersions('no-such-app')).toThrow(/not found/);
  });
});
