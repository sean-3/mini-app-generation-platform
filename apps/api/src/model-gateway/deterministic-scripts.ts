import type { BaseMessage } from '@langchain/core/messages';
import { lastToolResult, lastUserText, type PlanStep } from './deterministic-model';
import type { TemplatesService, TemplateId } from '../templates/templates.service';

/**
 * 单测用的确定性模型剧本：每个阶段（plan / stageA / stageB / publish / review）
 * 按写死的顺序返回工具调用决策。
 *
 * 只给单测用（ModelGatewayService 的 testModelFactory）。生产路径不走这里，
 * 各阶段用 Kimi kimi-k3，工具调用顺序由模型自己决定。
 *
 * 剧本里的 JSON 结构要和 agent.service.ts 各阶段的 system prompt 里的输出契约一致，
 * 否则 E2E 测的是另一套东西。
 */
export interface DeterministicContext {
  input: string;
  templateId: string;
  teamMode: boolean;
  appName?: string;
  appId?: string;
  runId?: string;
  /** 对话改数据（edit 阶段）用的当前应用数据。 */
  currentData?: unknown;
  templates: TemplatesService;
}

function extractInput(text: string): string {
  const m = text.match(/用户需求：([\s\S]*?)。先调用/);
  return (m?.[1] ?? text).trim();
}

export function buildDeterministicScript(phase: string, ctx: DeterministicContext): PlanStep[] {
  const { input, templateId, teamMode, templates } = ctx;
  const template = templates.get(templateId as TemplateId)!;

  switch (phase) {
    case 'plan': {
      const team = teamMode ? ['Mike', 'Iris', 'Emma', 'Bob', 'Alex'] : ['Mike', 'Alex'];
      return [
        { type: 'tool', name: 'match_template', args: () => ({ input }) },
        {
          type: 'tool',
          name: 'read_template',
          args: (history) => ({ templateId: (lastToolResult(history) as any)?.templateId ?? templateId }),
        },
        {
          type: 'text',
          text: (history) => {
            const m = lastToolResult(history) as any;
            return JSON.stringify({
              goal: input,
              templateId: m?.templateId ?? templateId,
              templateName: template.name,
              steps: ['调研', '规格', '架构', '构建', '发布'],
              team,
              approvals: ['计划', '架构', '发布'],
              notes: ['只做 4 个模板之一，匹配不上就停下', '数据落 SQLite，刷新后还在', '发布后可改数据，再点 Update 更新线上版'],
            });
          },
        },
      ];
    }

    case 'stageA-main':
      return [
        {
          type: 'tool',
          name: 'task',
          args: () => ({ description: `用户需求：${input}。先调用 match_template 匹配模板，再输出需求清单 JSON。`, subagent_type: 'iris_emma' }),
        },
        {
          type: 'tool',
          name: 'task',
          args: (history) => ({
            description: `为模板 ${((lastToolResult(history) as any)?.templateId ?? templateId) as string} 出架构决策（含设计说明），先调用 read_template。`,
            subagent_type: 'bob',
          }),
        },
        { type: 'text', text: 'stage A done: requirements and architecture ready for review' },
      ];

    case 'stageA-iris-emma':
      return [
        {
          type: 'tool',
          name: 'match_template',
          args: (history) => ({ input: extractInput(lastUserText(history)) }),
        },
        {
          type: 'text',
          text: (history) => {
            const m = lastToolResult(history) as any;
            const tid = m?.templateId ?? templateId;
            const t = templates.get(tid as TemplateId);
            return JSON.stringify({
              templateId: tid,
              confidence: m?.confidence ?? 0.9,
              requirements: [
                `创建「${t?.name ?? tid}」应用，支持查看与编辑`,
                '数据保存到后端，刷新后还在',
                `字段校验：${(t?.fields ?? []).map((f) => f.label).join('、')}`,
                '空态与错误态有提示',
              ],
            });
          },
        },
      ];

    case 'stageA-bob':
      return [
        {
          type: 'tool',
          name: 'read_template',
          args: (history) => ({ templateId: (lastToolResult(history) as any)?.templateId ?? templateId }),
        },
        {
          type: 'text',
          text: (history) => {
            const m = lastToolResult(history) as any;
            return JSON.stringify({
              templateId: m?.templateId ?? templateId,
              storage: 'apps 表，data_json 字段；草稿先写 drafts 表，审批通过后转正',
              tools: ['match_template', 'save_draft', 'validate_schema'],
              approvals: ['architecture', 'publish'],
              design: {
                layout: '生成出来的应用占主要位置，时间线收进右侧边栏',
                tokens: { primary: '#2563eb', surface: '#ffffff', muted: '#f5f5f4' },
                notes: ['卡片标题加粗，元信息灰色小字', '操作按钮放卡片底部', '移动端单列，不横向溢出'],
              },
            });
          },
        },
      ];

    case 'stageA-simple':
      return [
        { type: 'tool', name: 'match_template', args: () => ({ input }) },
        {
          type: 'tool',
          name: 'read_template',
          args: (history) => ({ templateId: (lastToolResult(history) as any)?.templateId ?? templateId }),
        },
        {
          type: 'text',
          text: (history) => {
            const m = lastToolResult(history) as any;
            const tid = m?.templateId ?? templateId;
            const t = templates.get(tid as TemplateId);
            return JSON.stringify({
              templateId: tid,
              requirements: [
                `创建「${t?.name ?? tid}」应用，支持查看与编辑`,
                '数据保存到后端，刷新后还在',
                `字段校验：${(t?.fields ?? []).map((f) => f.label).join('、')}`,
                '空态与错误态有提示',
              ],
              architecture: {
                templateId: tid,
                storage: 'apps 表，data_json 字段；草稿先写 drafts 表，审批通过后转正',
                tools: ['match_template', 'save_draft', 'validate_schema'],
                approvals: ['architecture', 'publish'],
                design: {
                  layout: '生成出来的应用占主要位置，时间线收进右侧边栏',
                  notes: ['卡片标题加粗，元信息灰色小字', '操作按钮放卡片底部'],
                },
              },
            });
          },
        },
      ];

    case 'engineer-alex':
      return [
        { type: 'tool', name: 'match_template', args: () => ({ input }) },
        {
          type: 'tool',
          name: 'save_draft',
          args: () => ({ templateId, name: ctx.appName ?? template.name, data: templates.seedData(templateId as TemplateId) }),
        },
        {
          type: 'tool',
          name: 'validate_schema',
          args: (history) => ({ draftId: (lastToolResult(history) as any)?.draftId }),
        },
        {
          type: 'text',
          text: (history) => {
            const v = lastToolResult(history) as any;
            return JSON.stringify({ draftReady: v?.valid === true, valid: v?.valid ?? false, errors: v?.errors ?? [] });
          },
        },
      ];

    case 'engineer-main':
      return [
        {
          type: 'tool',
          name: 'task',
          args: () => ({ description: `用户需求：${input}。只派 Alex：匹配模板、生成草稿、自检。`, subagent_type: 'alex' }),
        },
        { type: 'text', text: 'engineer mode done: draft generated and self-checked' },
      ];

    case 'stageB-alex':
      return [
        {
          type: 'tool',
          name: 'save_draft',
          args: () => ({ templateId, name: ctx.appName ?? template.name, data: templates.seedData(templateId as TemplateId) }),
        },
        {
          type: 'tool',
          name: 'validate_schema',
          args: (history) => ({ draftId: (lastToolResult(history) as any)?.draftId }),
        },
        {
          type: 'text',
          text: (history) => {
            const v = lastToolResult(history) as any;
            return JSON.stringify({ draftReady: v?.valid === true, valid: v?.valid ?? false, errors: v?.errors ?? [] });
          },
        },
      ];

    case 'stageB-main':
      return [
        {
          type: 'tool',
          name: 'task',
          args: () => ({ description: `按架构生成应用草稿，模板 ${templateId}，应用名 ${ctx.appName ?? template.name}。先调用 save_draft，再调用 validate_schema。`, subagent_type: 'alex' }),
        },
        { type: 'text', text: 'stage B done: draft generated and self-checked' },
      ];

    case 'publish':
      return [
        { type: 'tool', name: 'check_health', args: () => ({}) },
        { type: 'text', text: 'health ok, ready to publish' },
      ];

    case 'review':
      return [
        { type: 'tool', name: 'run_smoke_tests', args: () => ({}) },
        { type: 'tool', name: 'compute_eval', args: () => ({}) },
        { type: 'text', text: 'review done' },
      ];

    case 'edit': {
      // 对话改数据（只改数据版）的确定性剧本：不调工具，一次文本返回改完的完整数据。
      // 按输入里的关键词做固定改动（单测用）；生产走真模型。
      return [
        {
          type: 'text',
          text: () => JSON.stringify(applyDeterministicEdit(templateId, ctx.currentData, input)),
        },
      ];
    }

    default:
      throw new Error(`unknown deterministic phase: ${phase}`);
  }
}

/**
 * 确定性改动规则（单测用）：输入含“加”就往主数组尾部加一条；含“删”就去掉最后一条；
 * 其他输入原样返回（等于没改动）。只覆盖单测要断言的路径，不模拟真模型。
 */
function applyDeterministicEdit(templateId: string, currentData: unknown, input: string): unknown {
  const data = JSON.parse(JSON.stringify(currentData ?? {}));
  const has = (s: string) => input.includes(s);
  if (has('删')) {
    const key = mainArrayKey(templateId);
    if (key && Array.isArray(data[key]) && data[key].length > 0) data[key].pop();
    return data;
  }
  if (!has('加')) return data;
  const key = mainArrayKey(templateId);
  if (!key || !Array.isArray(data[key])) return data;
  if (templateId === 'signup') {
    data[key].push({ id: 's-edit', name: '新报名', count: 1, note: '', building: '', slot: '上午 09:00-11:00', phone: '', items: '' });
  } else if (templateId === 'ledger') {
    const m = input.match(/(\d+(?:\.\d+)?)/);
    data[key].push({ id: 'r-edit', amount: m ? Number(m[1]) : 100, category: '其他', date: new Date().toISOString().slice(0, 10), note: '' });
  } else if (templateId === 'habit') {
    data[key].push({ id: 'h-edit', name: '新习惯', streak: 0, week: [false, false, false, false, false, false, false] });
  } else if (templateId === 'quote') {
    data[key].push({ id: 'q-edit', item: '新增项目', qty: 1, price: 100 });
  }
  return data;
}

function mainArrayKey(templateId: string): string | null {
  return templateId === 'signup' ? 'signups' : templateId === 'ledger' ? 'records' : templateId === 'habit' ? 'habits' : templateId === 'quote' ? 'rows' : null;
}
