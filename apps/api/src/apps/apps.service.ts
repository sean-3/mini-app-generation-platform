import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../persistence/database.service';
import { TemplatesService, type TemplateId } from '../templates/templates.service';
import { ToolGatewayService } from '../tool-gateway/tool-gateway.service';

export interface AppRow {
  id: string;
  name: string;
  template_id: string;
  data_json: string;
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
  ) {}

  list(): Array<{ id: string; name: string; template_id: string; created_at: string }> {
    return this.db.query('SELECT id, name, template_id, created_at FROM apps ORDER BY created_at DESC');
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
      'INSERT INTO apps (id, name, template_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      name || t.name,
      templateId,
      JSON.stringify(t.seed()),
      now,
      now,
    );
    return this.get(id);
  }

  updateData(id: string, data: unknown): AppRow {
    const app = this.get(id);
    const v = this.templates.validateData(app.template_id as TemplateId, data);
    if (!v.valid) throw new Error(`data invalid: ${v.errors.join('; ')}`);
    this.db.run('UPDATE apps SET data_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(data), new Date().toISOString(), id);
    return this.get(id);
  }

  delete(id: string): { deleted: boolean } {
    this.get(id);
    this.db.run('DELETE FROM apps WHERE id = ?', id);
    return { deleted: true };
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
