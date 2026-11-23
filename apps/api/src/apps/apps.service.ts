import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { HumanMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../persistence/database.service';
import { TemplatesService, type TemplateId } from '../templates/templates.service';
import { ToolGatewayService } from '../tool-gateway/tool-gateway.service';
import { ModelGatewayService } from '../model-gateway/model-gateway.service';
import { parseJsonLoose } from '../common/json';
import { summarizeChanges, type TopLevelChange } from './diff';

export interface AppRow {
  id: string;
  name: string;
  template_id: string;
  data_json: string;
  /** 线上快照：最后一次 Publish / Update 时的数据；null = 从未发布。 */
  published_json: string | null;
  /** 线上版本号：首次发布 v1，每次 Update +1；0 = 从未发布。 */
  published_version: number;
  created_at: string;
  updated_at: string;
}

/** 应用实例：CRUD + 模板内数据操作。写操作先过模板 Schema 校验。 */
@Injectable()
export class AppsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly templates: TemplatesService,
    private readonly gatewayService: ToolGatewayService,
    private readonly modelGateway: ModelGatewayService,
  ) {}

  list(): Array<{ id: string; name: string; template_id: string; published_version: number; created_at: string }> {
    return this.db.query('SELECT id, name, template_id, published_version, created_at FROM apps ORDER BY created_at DESC');
  }

  get(id: string): AppRow {
    const row = this.db.get<AppRow>('SELECT * FROM apps WHERE id = ?', id);
    if (!row) throw new NotFoundException(`app ${id} not found`);
    return row;
  }

  create(templateId: string, name: string): AppRow {
    const t = this.templates.get(templateId);
    if (!t) throw new NotFoundException(`template ${templateId} not found`);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO apps (id, name, template_id, data_json, published_json, published_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      name || t.name,
      templateId,
      JSON.stringify(t.seed()),
      null,
      0,
      now,
      now,
    );
    return this.get(id);
  }

  /**
   * Update（对应 Atoms 的 Update）：把当前工作区数据推成新的线上版。
   * data_json 是工作区（Preview），published_json 是线上快照；改数据只动工作区，
   * 只有点 Update 才会更新线上版并把版本号 +1。首次发布也是走这里，v0 → v1。
   * 每次成功发布都在 app_versions 里写一行快照（供 Restore 用）。
   */
  publishUpdate(id: string): AppRow {
    const app = this.get(id);
    const nextVersion = (app.published_version ?? 0) + 1;
    this.db.run(
      'UPDATE apps SET published_json = ?, published_version = ?, updated_at = ? WHERE id = ?',
      app.data_json,
      nextVersion,
      new Date().toISOString(),
      id,
    );
    this.db.run(
      'INSERT INTO app_versions (id, app_id, version, data_json, created_at) VALUES (?, ?, ?, ?, ?)',
      randomUUID(),
      id,
      nextVersion,
      app.data_json,
      new Date().toISOString(),
    );
    return this.get(id);
  }

  /** 版本列表：该应用每次 Publish/Update 的快照（新在前）。 */
  listVersions(id: string): Array<{ version: number; created_at: string }> {
    this.get(id);
    return this.db.query<{ version: number; created_at: string }>(
      'SELECT version, created_at FROM app_versions WHERE app_id = ? ORDER BY version DESC',
      id,
    );
  }

  /**
   * Restore：把某版本快照的数据拷回工作区 data_json（变成未发布改动，
   * 不直接改线上快照；用户再点 Update 才会发布）。版本不存在返回 400。
   */
  restore(id: string, version: number): AppRow {
    const app = this.get(id);
    const row = this.db.get<{ data_json: string }>(
      'SELECT data_json FROM app_versions WHERE app_id = ? AND version = ?',
      id,
      version,
    );
    if (!row) throw new BadRequestException(`版本 v${version} 不存在（该应用没有这个版本的快照）。`);
    const parsed = this.templates.parseData(app.template_id as TemplateId, JSON.parse(row.data_json));
    if (!parsed.ok) throw new BadRequestException(`版本 v${version} 的数据已不合法：${parsed.errors.join('; ')}`);
    this.db.run('UPDATE apps SET data_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(parsed.data), new Date().toISOString(), id);
    return this.get(id);
  }

  updateData(id: string, data: unknown): AppRow {
    const app = this.get(id);
    const parsed = this.templates.parseData(app.template_id as TemplateId, data);
    if (!parsed.ok) throw new BadRequestException(`data invalid: ${parsed.errors.join('; ')}`);
    this.db.run('UPDATE apps SET data_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(parsed.data), new Date().toISOString(), id);
    return this.get(id);
  }

  /**
   * 对话改数据（只改数据版）：模型按用户一句话改当前应用的数据。
   * 单次模型调用，只输出完整的新 data_json；不许改 template_id、不许改结构、
   * 不许加模板外的顶层字段。服务端用 parseData 归一化校验后才写工作区，
   * 只动 data_json，不动 published_json（线上版要用户再点 Update 才变）。
   * 校验失败抛 400，不落库。
   */
  async editData(id: string, input: string): Promise<{ app: AppRow; changes: TopLevelChange[] }> {
    const app = this.get(id);
    // 没 key 不调模型：和 createRun 一致，直接报明确错误，不用假模型冒充。
    if (!this.modelGateway.isTestMode() && !this.modelGateway.hasCloudModel()) {
      throw new BadRequestException(
        'MOONSHOT_API_KEY 未设置：请设置环境变量 MOONSHOT_API_KEY（Moonshot 国内站 platform.moonshot.cn 的 key），否则无法改数据。',
      );
    }
    const template = this.templates.get(app.template_id as TemplateId);
    if (!template) throw new NotFoundException(`template ${app.template_id} not found`);
    const current = JSON.parse(app.data_json);
    const fields = template.fields.map((f) => `${f.key}(${f.label})`).join('、');
    const model = this.modelGateway.createModel('edit', {
      input,
      templateId: app.template_id,
      appId: id,
      currentData: current,
      templates: this.templates,
    });
    const prompt =
      `你是应用数据编辑器。应用是「${template.name}」，模板字段：${fields}。\n` +
      `当前数据 JSON：${JSON.stringify(current)}\n` +
      `用户要求：${input}\n` +
      '只输出完整的新数据 JSON（不要 markdown 围栏、不要解释）：保持同一模板、同一结构；' +
      '只改用户要求改的部分，其他原样保留；已有行的 id 不变，新增行给新 id；' +
      '不许加模板外的顶层字段，不许改 template_id。';
    const res = await model.invoke([new HumanMessage(prompt)]);
    const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    const next = parseJsonLoose(text);
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new BadRequestException('模型没有返回有效的新数据 JSON，请换个说法再试。');
    }
    const parsed = this.templates.parseData(app.template_id as TemplateId, next);
    if (!parsed.ok) throw new BadRequestException(`改完的数据不合法：${parsed.errors.join('; ')}`);
    const changes = summarizeChanges(current, parsed.data);
    this.db.run('UPDATE apps SET data_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(parsed.data), new Date().toISOString(), id);
    return { app: this.get(id), changes };
  }

  delete(id: string): { deleted: boolean } {
    this.get(id);
    this.db.run('DELETE FROM apps WHERE id = ?', id);
    return { deleted: true };
  }

  /** Remix / 克隆：复制当前应用成独立新项目（新 id、名字后加“副本”、数据照搬、未发布）。 */
  clone(id: string): AppRow {
    const src = this.get(id);
    const nid = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO apps (id, name, template_id, data_json, published_json, published_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      nid,
      `${src.name} 副本`,
      src.template_id,
      src.data_json,
      null,
      0,
      now,
      now,
    );
    return this.get(nid);
  }

  rename(id: string, name: string): AppRow {
    this.get(id);
    this.db.run('UPDATE apps SET name = ?, updated_at = ? WHERE id = ?', name, new Date().toISOString(), id);
    return this.get(id);
  }

  /** 导出 JSON：走网关（允许）。 */
  async exportJson(id: string): Promise<{ data: unknown }> {
    const app = this.get(id);
    const gateway = this.gatewayService.createGateway();
    const result = await gateway.execute('export_json', { appId: id }, undefined, async () => ({ content: app.data_json }));
    if (!result.ok) return JSON.parse(result.content);
    return { data: JSON.parse(result.content) };
  }

  /**
   * 导出为文件：走网关，权限拦截一步拒绝，返回 isError:true 的正常消息，
   * HTTP 200，不抛错（“永不抛出”同样适用于 REST 层）。
   */
  async exportFile(id: string, format: string): Promise<Record<string, unknown>> {
    this.get(id);
    const gateway = this.gatewayService.createGateway();
    const result = await gateway.execute(
      'export_file',
      { appId: id, format },
      undefined,
      async () => ({ content: JSON.stringify({ written: `${id}.${format}` }) }),
    );
    return JSON.parse(result.content);
  }
}
