import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createDeepAgent, createSubAgent } from 'deepagents';
import { HumanMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../persistence/database.service';
import { TemplatesService, type TemplateId } from '../templates/templates.service';
import { ModelGatewayService } from '../model-gateway/model-gateway.service';
import { ToolGatewayService, createToolGatewayMiddleware, type GatewayTrace } from '../tool-gateway/tool-gateway.service';
import { DeterministicModel, lastToolResult, lastUserText, type PlanStep } from '../model-gateway/deterministic-model';
import { buildTools } from './tools';
import { EvalService } from '../eval/eval.service';
import { RunEventHub } from './run-hub';

export type RunStatus =
  | 'running'
  | 'awaiting_architecture'
  | 'generating'
  | 'awaiting_publish'
  | 'testing'
  | 'published'
  | 'rolled_back'
  | 'stopped';

export interface RunRow {
  id: string;
  input: string;
  status: RunStatus;
  template_id: string | null;
  requirements_json: string | null;
  design_json: string | null;
  architecture_json: string | null;
  draft_json: string | null;
  app_id: string | null;
  created_at: string;
  updated_at: string;
}

// deepagents 1.17.0：传给 createDeepAgent 的 subagents 必须是原始 spec 对象，
// 不能传 createSubAgent 编译后的 ReactAgent——编译产物没有 .name，
// 框架在 getSubagents 里按 agentParams.name 去重会报 Duplicate subagent name 'undefined'。
// 这里直接返回 spec，让框架内部编译。
const subAgent = (spec: Parameters<typeof createSubAgent>[0]) => spec as any;

/**
 * Agent 编排（Mike 协调者 + 8 个职能 subagents）。
 *
 * 两道审批用自维护状态机实现（评审允许的两种落法之一），不用 LangGraph
 * interrupt_on：审批是阶段之间的 UI 门，不是工具调用门；状态机更简单、
 * 可测试，轨迹里照样留痕。选择写在 README 里。
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly templates: TemplatesService,
    private readonly modelGateway: ModelGatewayService,
    private readonly gatewayService: ToolGatewayService,
    private readonly evalService: EvalService,
    private readonly hub: RunEventHub,
  ) {}

  // ---------------- run CRUD ----------------

  createRun(input: string): RunRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO runs (id, input, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      input,
      'running',
      now,
      now,
    );
    // 本地路由短路：未命中模板就不启动流水线，只出引导（Model Gateway 第 1 级）。
    const route = this.modelGateway.routeLocal(input);
    if (!route.templateId) {
      this.updateRun(id, { status: 'stopped' });
      this.recordTrace(id, 'Mike', 'stage', null, null, JSON.stringify({ guidance: '未匹配到四个模板，请点模板卡片或换个说法再试。' }), false, 0);
      this.hub.emit(id, 'run_stopped', 'Mike', { reason: 'no_template_match' });
      return this.getRun(id);
    }
    void this.executeStageA(id, input, route.templateId).catch((err) => {
      this.updateRun(id, { status: 'stopped' });
      this.recordTrace(id, 'Mike', 'stage', null, null, JSON.stringify({ error: String(err?.message ?? err) }), true, 0);
      this.hub.emit(id, 'run_stopped', 'Mike', { error: String(err?.message ?? err) });
    });
    return this.getRun(id);
  }

  getRun(id: string): RunRow {
    const row = this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
    if (!row) throw new NotFoundException(`run ${id} not found`);
    return row;
  }

  listRuns(): RunRow[] {
    return this.db.query<RunRow>('SELECT * FROM runs ORDER BY created_at DESC LIMIT 50');
  }

  getReplay(id: string): { run: RunRow; traces: any[]; eval: any | null } {
    const run = this.getRun(id);
    const traces = this.db.query('SELECT * FROM traces WHERE run_id = ? ORDER BY seq ASC', id);
    const ev = this.evalService.latest(id);
    return { run, traces, eval: ev };
  }

  // ---------------- approvals ----------------

  approveArchitecture(id: string, approved: boolean): RunRow {
    const run = this.getRun(id);
    if (run.status !== 'awaiting_architecture') {
      throw new BadRequestException(`run ${id} is ${run.status}, not awaiting architecture approval`);
    }
    this.recordTrace(id, 'Mike', 'approval', 'approve_architecture', JSON.stringify({ approved }), JSON.stringify({ approved }), false, 0);
    this.hub.emit(id, 'approval_decided', 'Mike', { kind: 'architecture', approved });
    if (!approved) {
      this.updateRun(id, { status: 'rolled_back' });
      return this.getRun(id);
    }
    this.updateRun(id, { status: 'generating' });
    void this.executeStageB(id).catch((err) => {
      this.updateRun(id, { status: 'stopped' });
      this.recordTrace(id, 'Mike', 'stage', null, null, JSON.stringify({ error: String(err?.message ?? err) }), true, 0);
    });
    return this.getRun(id);
  }

  approvePublish(id: string, approved: boolean): RunRow {
    const run = this.getRun(id);
    if (run.status !== 'awaiting_publish') {
      throw new BadRequestException(`run ${id} is ${run.status}, not awaiting publish approval`);
    }
    this.recordTrace(id, 'Mike', 'approval', 'approve_publish', JSON.stringify({ approved }), JSON.stringify({ approved }), false, 0);
    this.hub.emit(id, 'approval_decided', 'Mike', { kind: 'publish', approved });
    if (!approved) {
      this.updateRun(id, { status: 'rolled_back' });
      return this.getRun(id);
    }
    this.updateRun(id, { status: 'testing' });
    void this.executePublish(id).catch((err) => {
      this.updateRun(id, { status: 'stopped' });
      this.recordTrace(id, 'Mike', 'stage', null, null, JSON.stringify({ error: String(err?.message ?? err) }), true, 0);
    });
    return this.getRun(id);
  }

  /** 重复调用演示：模型连续 3 次发起同一工具调用，网关在第 3 次拦截并熔断。 */
  repeatDemo(input: string): RunRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run('INSERT INTO runs (id, input, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, input, 'running', now, now);
    void this.executeRepeatDemo(id, input).catch((err) => {
      this.updateRun(id, { status: 'stopped' });
      this.recordTrace(id, 'Mike', 'stage', null, null, JSON.stringify({ error: String(err?.message ?? err) }), true, 0);
    });
    return this.getRun(id);
  }

  // ---------------- stages ----------------

  private async executeRepeatDemo(runId: string, input: string): Promise<void> {
    const { gateway, middleware, tools } = this.buildAgentParts(runId);
    const model = this.modelGateway.createDeterministicModel([
      { type: 'tool', name: 'match_template', args: () => ({ input }) },
      { type: 'tool', name: 'match_template', args: () => ({ input }) },
      { type: 'tool', name: 'match_template', args: () => ({ input }) },
      { type: 'text', text: 'repeat detected by gateway; stopped with partial results' },
    ]);
    const agent = createDeepAgent({ model, tools: Object.values(tools), middleware: [middleware], systemPrompt: 'You are Mike.' });
    await agent.invoke({ messages: [new HumanMessage('repeat the same tool call three times')] });
    this.updateRun(runId, { status: 'stopped' });
    this.hub.emit(runId, 'run_stopped', 'Mike', { reason: 'repeat_call', circuitOpen: gateway.isCircuitOpen });
  }

  /** Stage A：Iris+Emma 合并（需求）→ Nora 与 Bob 并行（设计 + 架构）→ 等架构审批。 */
  private async executeStageA(runId: string, input: string, templateId: string): Promise<void> {
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);
    const template = this.templates.get(templateId as TemplateId)!;

    const irisEmma = subAgent({
      name: 'iris_emma',
      description: 'Research the request and write the requirements list.',
      systemPrompt: 'You are Iris (research) + Emma (PM). First call match_template, then output a JSON requirements list.',
      mode: 'isolated',
      middleware: [middleware],
      tools: [tools.matchTemplate],
      model: this.modelGateway.createDeterministicModel([
        {
          type: 'tool',
          name: 'match_template',
          args: (history) => ({ input: this.extractInput(lastUserText(history)) }),
        },
        {
          type: 'text',
          text: (history) => {
            const m = lastToolResult(history) as any;
            const tid = m?.templateId ?? templateId;
            const t = this.templates.get(tid as TemplateId);
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
      ]),
    });

    const readTemplateArgs = (history: any[]) => {
      const m = lastToolResult(history) as any;
      const tid = m?.templateId ?? templateId;
      return { templateId: tid };
    };

    const nora = subAgent({
      name: 'nora',
      description: 'UI design: layout, design tokens, interaction review.',
      systemPrompt: 'You are Nora, the UI designer. First call read_template, then output design notes as JSON.',
      mode: 'isolated',
      middleware: [middleware],
      tools: [tools.readTemplate],
      model: this.modelGateway.createDeterministicModel([
        { type: 'tool', name: 'read_template', args: readTemplateArgs },
        {
          type: 'text',
          text: (history) => {
            const m = lastToolResult(history) as any;
            return JSON.stringify({
              templateId: m?.templateId ?? templateId,
              layout: '三栏：左流水线 / 中需求与审批 / 右实时预览',
              tokens: { primary: '#e63c30', surface: '#ffffff', muted: '#f5f5f4' },
              notes: ['卡片标题加粗，元信息灰色小字', '操作按钮放卡片底部', '移动端单列，不横向溢出'],
            });
          },
        },
      ]),
    });

    const bob = subAgent({
      name: 'bob',
      description: 'Architecture: module split, storage, tool contracts.',
      systemPrompt: 'You are Bob, the architect. First call read_template, then output the architecture decision as JSON.',
      mode: 'isolated',
      middleware: [middleware],
      tools: [tools.readTemplate],
      model: this.modelGateway.createDeterministicModel([
        { type: 'tool', name: 'read_template', args: readTemplateArgs },
        {
          type: 'text',
          text: (history) => {
            const m = lastToolResult(history) as any;
            return JSON.stringify({
              templateId: m?.templateId ?? templateId,
              storage: 'apps 表，data_json 字段；草稿先写 drafts 表，审批通过后转正',
              tools: ['match_template', 'save_draft', 'validate_schema'],
              approvals: ['architecture', 'publish'],
            });
          },
        },
      ]),
    });

    const templateIdFrom = (history: any[]): string => {
      const r = lastToolResult(history) as any;
      return r?.templateId ?? templateId;
    };

    const mainModel = this.modelGateway.createDeterministicModel([
      {
        type: 'tool',
        name: 'task',
        args: () => ({ description: `用户需求：${input}。先调用 match_template 匹配模板，再输出需求清单 JSON。`, subagent_type: 'iris_emma' }),
      },
      {
        type: 'tools',
        calls: [
          {
            name: 'task',
            args: (history) => ({
              description: `为模板 ${templateIdFrom(history)} 出设计说明，先调用 read_template。`,
              subagent_type: 'nora',
            }),
          },
          {
            name: 'task',
            args: (history) => ({
              description: `为模板 ${templateIdFrom(history)} 出架构决策，先调用 read_template。`,
              subagent_type: 'bob',
            }),
          },
        ],
      },
      { type: 'text', text: 'stage A done: requirements, design and architecture ready for review' },
    ]);

    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      subagents: [irisEmma, nora, bob],
      systemPrompt: 'You are Mike, the team coordinator. Delegate to subagents, then summarize.',
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'A', label: '需求 + 设计 + 架构' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成应用：${input}`)] });
    const taskResults = this.extractTaskResults(result.messages as any[]);
    const requirements = taskResults.iris_emma ?? null;
    const design = taskResults.nora ?? null;
    const architecture = taskResults.bob ?? null;
    this.updateRun(runId, {
      status: 'awaiting_architecture',
      template_id: templateId,
      requirements_json: requirements ? JSON.stringify(requirements) : null,
      design_json: design ? JSON.stringify(design) : null,
      architecture_json: architecture ? JSON.stringify(architecture) : null,
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'architecture' });
  }

  /** Stage B：Alex 生成草稿并自检 → 等发布审批。 */
  private async executeStageB(runId: string): Promise<void> {
    const run = this.getRun(runId);
    const templateId = run.template_id as TemplateId;
    const template = this.templates.get(templateId)!;
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);
    const appName = `${template.name} · ${run.input.slice(0, 12)}`;

    const alex = subAgent({
      name: 'alex',
      description: 'Development: assemble the app draft from the template and self-check it.',
      systemPrompt: 'You are Alex, the developer. Call save_draft, then validate_schema, then summarize.',
      mode: 'isolated',
      middleware: [middleware],
      tools: [tools.saveDraft, tools.validateSchema],
      model: this.modelGateway.createDeterministicModel([
        {
          type: 'tool',
          name: 'save_draft',
          args: () => ({ templateId, name: appName, data: this.templates.seedData(templateId) }),
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
      ]),
    });

    const mainModel = this.modelGateway.createDeterministicModel([
      {
        type: 'tool',
        name: 'task',
        args: () => ({ description: `按架构生成应用草稿，模板 ${templateId}，应用名 ${appName}。先调用 save_draft，再调用 validate_schema。`, subagent_type: 'alex' }),
      },
      { type: 'text', text: 'stage B done: draft generated and self-checked' },
    ]);

    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      subagents: [alex],
      systemPrompt: 'You are Mike, the team coordinator. Delegate generation to Alex, then summarize.',
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'B', label: '开发：生成草稿' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成草稿：${appName}`)] });
    const taskResults = this.extractTaskResults(result.messages as any[]);
    const draftRow = this.db.get<{ id: string; data_json: string }>(
      'SELECT id, data_json FROM drafts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
      runId,
    );
    this.updateRun(runId, {
      status: 'awaiting_publish',
      draft_json: draftRow
        ? JSON.stringify({ draftId: draftRow.id, templateId, name: appName, data: JSON.parse(draftRow.data_json), alex: taskResults.alex ?? null })
        : null,
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'publish' });
  }

  /** 发布：Oscar 健康检查 → 落盘成正式应用 → Tina 冒烟 + David 评估（异步，不堵主流程）。 */
  private async executePublish(runId: string): Promise<void> {
    const run = this.getRun(runId);
    const draft = JSON.parse(run.draft_json ?? '{}');
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);

    const oscar = subAgent({
      name: 'oscar',
      description: 'Ops: pre-publish health check.',
      systemPrompt: 'You are Oscar, the ops engineer. Call check_health, then confirm.',
      mode: 'isolated',
      middleware: [middleware],
      tools: [tools.checkHealth],
      model: this.modelGateway.createDeterministicModel([
        { type: 'tool', name: 'check_health', args: () => ({}) },
        { type: 'text', text: 'health ok, ready to publish' },
      ]),
    });

    const mainModel = this.modelGateway.createDeterministicModel([
      {
        type: 'tool',
        name: 'task',
        args: () => ({ description: '发布前检查：调用 check_health。', subagent_type: 'oscar' }),
      },
      { type: 'text', text: 'publish checks done' },
    ]);

    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      subagents: [oscar],
      systemPrompt: 'You are Mike, the team coordinator.',
    });
    await agent.invoke({ messages: [new HumanMessage('publish checks')] });

    const appId = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO apps (id, name, template_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      appId,
      draft.name ?? '未命名应用',
      draft.templateId,
      JSON.stringify(draft.data ?? {}),
      now,
      now,
    );
    this.updateRun(runId, { status: 'published', app_id: appId });
    this.hub.emit(runId, 'app_published', 'Oscar', { appId });

    // Tina 冒烟 + David 评估：异步跑，不堵发布返回。
    void this.executeReview(runId, appId).catch(() => undefined);
  }

  private async executeReview(runId: string, appId: string): Promise<void> {
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);

    const tina = subAgent({
      name: 'tina',
      description: 'QA: smoke tests for the published app.',
      systemPrompt: 'You are Tina, the QA engineer. Call run_smoke_tests, then report.',
      mode: 'isolated',
      middleware: [middleware],
      tools: [tools.runSmokeTests],
      model: this.modelGateway.createDeterministicModel([
        { type: 'tool', name: 'run_smoke_tests', args: () => ({ appId }) },
        { type: 'text', text: (history) => JSON.stringify(lastToolResult(history) ?? {}) },
      ]),
    });

    const david = subAgent({
      name: 'david',
      description: 'Data: compute the evaluation score for the run.',
      systemPrompt: 'You are David, the data analyst. Call compute_eval, then summarize.',
      mode: 'isolated',
      middleware: [middleware],
      tools: [tools.computeEval],
      model: this.modelGateway.createDeterministicModel([
        { type: 'tool', name: 'compute_eval', args: () => ({ runId }) },
        { type: 'text', text: (history) => JSON.stringify(lastToolResult(history) ?? {}) },
      ]),
    });

    const mainModel = this.modelGateway.createDeterministicModel([
      {
        type: 'tools',
        calls: [
          { name: 'task', args: () => ({ description: `冒烟测试应用 ${appId}：调用 run_smoke_tests。`, subagent_type: 'tina' }) },
          { name: 'task', args: () => ({ description: `评估本次运行 ${runId}：调用 compute_eval。`, subagent_type: 'david' }) },
        ],
      },
      { type: 'text', text: 'review done' },
    ]);

    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      subagents: [tina, david],
      systemPrompt: 'You are Mike, the team coordinator.',
    });
    await agent.invoke({ messages: [new HumanMessage('post-publish review')] });
    const ev = this.evalService.latest(runId);
    this.hub.emit(runId, 'eval_ready', 'David', ev);
  }

  // ---------------- helpers ----------------

  private buildAgentParts(runId: string) {
    const gateway = this.gatewayService.createGateway((t: GatewayTrace) => {
      this.recordTrace(runId, 'ToolGateway', 'tool', t.tool, null, JSON.stringify({ step: t.step, outcome: t.outcome, detail: t.detail }), t.outcome === 'blocked', t.durationMs);
      this.hub.emit(runId, 'tool', 'ToolGateway', t);
    });
    const middleware = createToolGatewayMiddleware(gateway);
    const tools = buildTools({ db: this.db, templates: this.templates, evalService: this.evalService, runId });
    return { gateway, middleware, tools };
  }

  private updateRun(id: string, patch: Partial<RunRow>): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    this.db.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  private recordTrace(
    runId: string,
    actor: string,
    kind: string,
    tool: string | null,
    argsJson: string | null,
    resultJson: string | null,
    isError: boolean,
    durationMs: number,
  ): void {
    const seq = (this.db.get<{ m: number }>('SELECT COALESCE(MAX(seq), 0) AS m FROM traces WHERE run_id = ?', runId)?.m ?? 0) + 1;
    this.db.run(
      'INSERT INTO traces (run_id, seq, actor, kind, tool, args_json, result_json, is_error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      runId,
      seq,
      actor,
      kind,
      tool,
      argsJson,
      resultJson,
      isError ? 1 : 0,
      durationMs,
      new Date().toISOString(),
    );
  }

  private extractInput(text: string): string {
    const m = text.match(/用户需求：([\s\S]*?)。先调用/);
    return (m?.[1] ?? text).trim();
  }

  /** 从主 Agent 的消息历史里按 subagent 名提取 task 调用结果（JSON 优先，失败留原文）。 */
  private extractTaskResults(messages: any[]): Record<string, any> {
    const out: Record<string, any> = {};
    const byId = new Map<string, string>();
    for (const m of messages) {
      const calls = (m as any).tool_calls as Array<{ id: string; name: string; args: any }> | undefined;
      if (calls) {
        for (const c of calls) {
          if (c.name === 'task') byId.set(c.id, c.args?.subagent_type);
        }
      }
      const type = (m as any).getType?.() ?? (m as any).type;
      if (type === 'tool' && (m as any).tool_call_id && byId.has((m as any).tool_call_id)) {
        const name = byId.get((m as any).tool_call_id)!;
        const content = (m as any).content as string;
        try {
          out[name] = JSON.parse(content);
        } catch {
          out[name] = { raw: content };
        }
      }
    }
    return out;
  }
}
