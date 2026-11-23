import { tool } from 'langchain';
import { z } from 'zod';
import { DatabaseService } from '../persistence/database.service';
import { TemplatesService, SIGNUP_SLOTS, type TemplateId } from '../templates/templates.service';
import { EvalService } from '../eval/eval.service';
import { randomUUID } from 'crypto';

/**
 * Agent 工具集。每个工具的执行都会先经过 Tool Gateway 五步（见 tool-gateway），
 * 这里只写工具本身的业务逻辑。
 */
export function buildTools(deps: {
  db: DatabaseService;
  templates: TemplatesService;
  evalService: EvalService;
  runId: string;
  /** review 阶段已发布应用的 id；传了就绑定，模型传什么都不采用。 */
  appId?: string;
}) {
  const { db, templates, evalService, runId, appId: boundAppId } = deps;

  const matchTemplate = tool(
    async ({ input }: { input: string }) => {
      const m = templates.match(input);
      return JSON.stringify(
        m ?? { templateId: null, confidence: 0, reason: '未命中任何模板关键词' },
      );
    },
    {
      name: 'match_template',
      description: 'Match the user request to one of the four app templates.',
      schema: z.object({ input: z.string() }),
    },
  );

  const readTemplate = tool(
    async ({ templateId }: { templateId: string }) => {
      const t = templates.get(templateId);
      if (!t) return JSON.stringify({ error: `unknown template ${templateId}` });
      const seed = t.seed();
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(seed)) counts[k] = Array.isArray(v) ? v.length : 1;
      return JSON.stringify({
        templateId: t.id,
        name: t.name,
        description: t.description,
        fields: t.fields,
        seedCounts: counts,
        cap: t.cap ?? null,
      });
    },
    {
      name: 'read_template',
      description: 'Read a template schema, fields and seed data summary.',
      schema: z.object({ templateId: z.string() }),
    },
  );

  const saveDraft = tool(
    async ({ templateId, name, data }: { templateId: string; name: string; data?: unknown }) => {
      const t = templates.get(templateId);
      if (!t) return JSON.stringify({ isError: true, message: `unknown template ${templateId}` });
      const payload = data ?? t.seed();
      // 存解析后的数据：默认值补齐、未知字段去掉。只校验不归一化的话，
      // 模型自造的字段会原样进库、缺失字段进库后预览按模板渲染对不上。
      const parsed = templates.parseData(templateId as TemplateId, payload);
      if (!parsed.ok) return JSON.stringify({ isError: true, message: `seed data invalid: ${parsed.errors.join('; ')}` });
      const id = randomUUID();
      const now = new Date().toISOString();
      db.run(
        'INSERT INTO drafts (id, run_id, template_id, name, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        runId,
        templateId,
        name,
        JSON.stringify(parsed.data),
        now,
      );
      return JSON.stringify({ draftId: id, templateId, name });
    },
    {
      name: 'save_draft',
      description:
        'Save a generated app draft (template + seed data) to the drafts table. ' +
        'If you supply data, it must follow the template fields exactly: every signup needs name (text) and count (positive integer); ' +
        `slot must be one of ${SIGNUP_SLOTS.map((s) => `"${s}"`).join(', ')} — pick the one matching the pickup time in the user request; ` +
        'building, phone, items (what they ordered), note are optional text. Do not invent other field names; do not add top-level fields beyond the template data.',
      schema: z.object({
        templateId: z.string(),
        name: z.string(),
        data: z.unknown().optional(),
      }),
    },
  );

  const validateSchema = tool(
    async ({ draftId }: { draftId: string }) => {
      const row = db.get<{ template_id: string; data_json: string }>(
        'SELECT template_id, data_json FROM drafts WHERE id = ?',
        draftId,
      );
      if (!row) return JSON.stringify({ valid: false, errors: [`draft ${draftId} not found`] });
      const v = templates.validateData(row.template_id as TemplateId, JSON.parse(row.data_json));
      return JSON.stringify({ draftId, ...v });
    },
    {
      name: 'validate_schema',
      description: 'Validate a draft against its template Zod schema.',
      schema: z.object({ draftId: z.string() }),
    },
  );

  const exportJson = tool(
    async ({ appId }: { appId: string }) => {
      const row = db.get<{ data_json: string }>('SELECT data_json FROM apps WHERE id = ?', appId);
      if (!row) return JSON.stringify({ isError: true, message: `app ${appId} not found` });
      return row.data_json;
    },
    {
      name: 'export_json',
      description: 'Export an app as JSON.',
      schema: z.object({ appId: z.string() }),
    },
  );

  const exportFile = tool(
    async ({ appId, format }: { appId: string; format: string }) => {
      // 正常情况下网关在权限拦截一步就会拒绝，执行不到这里。
      // 保留实现是为了让“工具存在但无权限”这个事实成立。
      return JSON.stringify({ written: `${appId}.${format}` });
    },
    {
      name: 'export_file',
      description: 'Write app data to a file on disk.',
      schema: z.object({ appId: z.string(), format: z.enum(['csv', 'json']) }),
    },
  );

  const runSmokeTests = tool(
    async (args: { appId?: string }) => {
      // appId 服务端绑定：review 阶段传已发布应用的 id；模型传什么都不采用。
      // 没绑定时才用模型传的 appId（其他阶段 / 测试用）。
      const id = boundAppId ?? args.appId;
      if (!id) return JSON.stringify({ passed: false, checks: [{ name: 'app exists', ok: false }] });
      const row = db.get<{ template_id: string; data_json: string }>(
        'SELECT template_id, data_json FROM apps WHERE id = ?',
        id,
      );
      if (!row) return JSON.stringify({ passed: false, checks: [{ name: 'app exists', ok: false }] });
      const v = templates.validateData(row.template_id as TemplateId, JSON.parse(row.data_json));
      const checks = [
        { name: 'app exists', ok: true },
        { name: 'data matches template schema', ok: v.valid },
        { name: 'template renders', ok: Boolean(templates.get(row.template_id)) },
      ];
      return JSON.stringify({ passed: checks.every((c) => c.ok), checks });
    },
    {
      name: 'run_smoke_tests',
      description: boundAppId
        ? 'Run smoke tests (existence, schema, render) for the published app. No arguments needed: the app is already bound by the server.'
        : 'Run smoke tests (existence, schema, render) for a published app.',
      schema: boundAppId ? z.object({}) : z.object({ appId: z.string() }),
    },
  );

  const computeEval = tool(
    async () => {
      // runId 服务端绑定：模型不知道当前 run 的 id，传进来的值不可信
      // （线上实测 run 5bb54c6d：模型传错 runId，eval 写到了别的 run 下，回放页查不到）。
      const e = evalService.compute(runId);
      return JSON.stringify(e);
    },
    {
      name: 'compute_eval',
      description: 'Compute the evaluation score (success rate / steps / duration) for the current run. No arguments needed: the run is already bound by the server.',
      schema: z.object({}),
    },
  );

  const checkHealth = tool(async () => JSON.stringify({ status: 'ok', uptime: process.uptime() }), {
    name: 'check_health',
    description: 'Health check of the deployment.',
    schema: z.object({}),
  });

  const listApps = tool(
    async () => {
      const rows = db.query<{ id: string; name: string; template_id: string }>(
        'SELECT id, name, template_id FROM apps ORDER BY created_at DESC',
      );
      return JSON.stringify(rows);
    },
    {
      name: 'list_apps',
      description: 'List published apps.',
      schema: z.object({}),
    },
  );

  return {
    matchTemplate,
    readTemplate,
    saveDraft,
    validateSchema,
    exportJson,
    exportFile,
    runSmokeTests,
    computeEval,
    checkHealth,
    listApps,
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
