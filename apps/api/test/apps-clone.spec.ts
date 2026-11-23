import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../src/persistence/database.service';
import { TemplatesService } from '../src/templates/templates.service';
import { ModelGatewayService } from '../src/model-gateway/model-gateway.service';
import { ToolGatewayService } from '../src/tool-gateway/tool-gateway.service';
import { AppsService } from '../src/apps/apps.service';

describe('AppsService.clone (Remix)', () => {
  let dir: string;
  let apps: AppsService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-clone-'));
    process.env.DATA_DIR = dir;
    const db = new DatabaseService();
    db.onModuleInit();
    const templates = new TemplatesService();
    apps = new AppsService(db, templates, new ToolGatewayService(), new ModelGatewayService(templates));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('clone copies data into a new unpublished app with “副本” suffix', () => {
    const src = apps.create('signup', '团购接龙');
    apps.publishUpdate(src.id);
    const copy = apps.clone(src.id);
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe('团购接龙 副本');
    expect(copy.template_id).toBe('signup');
    expect(copy.data_json).toBe(src.data_json);
    expect(copy.published_json).toBeNull();
    expect(copy.published_version).toBe(0);
    // 原应用不受影响。
    const orig = apps.get(src.id);
    expect(orig.published_version).toBe(1);
    expect(orig.name).toBe('团购接龙');
  });

  it('clone of an unpublished app also works', () => {
    const src = apps.create('ledger', '记账');
    const copy = apps.clone(src.id);
    expect(copy.name).toBe('记账 副本');
    expect(copy.published_version).toBe(0);
  });

  it('unknown app: 404', () => {
    expect(() => apps.clone('no-such-app')).toThrow(/not found/);
  });
});
