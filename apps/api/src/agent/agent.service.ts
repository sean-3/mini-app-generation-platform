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

export type RunMode = 'build' | 'plan' | 'engineer';

export type RunStatus =
  | 'running'
  | 'awaiting_plan'
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
  mode: RunMode;
  team_mode: number;
  plan_json: string | null;
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
 * Agent 编排。团队按 atoms.dev 的 5 个构建角色来：
 * Mike（协调 + 审批对接人）、Iris（调研）、Emma（规格）、Bob（架构，设计是架构输出的一部分）、
 * Alex（构建，冒烟自检是构建环节里的步骤）。没有测试、运维、UI 设计师、复盘这几个独立角色；
 * 冒烟 + 评估是产品功能，不挂人名。
 *
 * 三种启动方式（Build / Plan / Engineer）+ Team Mode 开关：
 * - Build：直接开工。Team Mode 开 = 完整 5 人流程；关 = Mike + Alex 简化流程。
 * - Plan：Mike 先出计划，用户批准才开工；拒绝回退。
 * - Engineer：只派 Alex 一人干活（轻量模式），Team Mode 对它无效。
 *
 * 审批是两道（架构确认、发布确认），Plan 模式多一道计划确认作为入口。
 * 两道审批用自维护状态机实现，不用 LangGraph interrupt_on：审批是阶段之间的
 * UI 门，不是工具调用门；状态机更简单、可测试，轨迹里照样留痕。
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

  createRun(input: string, opts: { mode?: RunMode; teamMode?: boolean } = {}): RunRow {
    const mode: RunMode = opts.mode === 'plan' || opts.mode === 'engineer' ? opts.mode : 'build';
    // Engineer 模式只派 Alex，Team Mode 对它无效。
    const teamMode = mode === 'engineer' ? false : opts.teamMode === true;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO runs (id, input, status, mode, team_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      input,
      'running',
      mode,
      teamMode ? 1 : 0,
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
    const start =
      mode === 'plan'
        ? this.executePlan(id, input, route.templateId, teamMode)
        : mode === 'engineer'
          ? this.executeEngineer(id, input, route.templateId)
          : this.executeStageA(id, input, route.templateId, teamMode);
    void start.catch((err) => {
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

  /** Plan 模式的入口审批：Mike 出计划，用户批准才开工。 */
  approvePlan(id: string, approved: boolean): RunRow {
    const run = this.getRun(id);
    if (run.status !== 'awaiting_plan') {
      throw new BadRequestException(`run ${id} is ${run.status}, not awaiting plan approval`);
    }
    this.recordTrace(id, 'Mike', 'approval', 'approve_plan', JSON.stringify({ approved }), JSON.stringify({ approved }), false, 0);
    this.hub.emit(id, 'approval_decided', 'Mike', { kind: 'plan', approved });
    if (!approved) {
      this.updateRun(id, { status: 'rolled_back' });
      return this.getRun(id);
    }
    this.updateRun(id, { status: 'running' });
    void this.executeStageA(id, run.input, run.template_id as TemplateId, run.team_mode === 1).catch((err) => {
      this.updateRun(id, { status: 'stopped' });
      this.recordTrace(id, 'Mike', 'stage', null, null, JSON.stringify({ error: String(err?.message ?? err) }), true, 0);
    });
    return this.getRun(id);
  }

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
    // Engineer 模式：Alex 在第一步已经生成了草稿，跳过 Stage B，直接等发布审批。
    if (run.mode === 'engineer' && run.draft_json) {
      this.updateRun(id, { status: 'awaiting_publish' });
      this.hub.emit(id, 'approval_requested', 'Mike', { kind: 'publish' });
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
    this.db.run(
      'INSERT INTO runs (id, input, status, mode, team_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      input,
      'running',
      'build',
      0,
      now,
      now,
    );
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

  /** Plan 模式：Mike 先出计划（目标、模板、步骤、参与的人、三道审批），等用户批准。 */
  private async executePlan(runId: string, input: string, templateId: string, teamMode: boolean): Promise<void> {
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);
    const template = this.templates.get(templateId as TemplateId)!;
    const team = teamMode ? ['Mike', 'Iris', 'Emma', 'Bob', 'Alex'] : ['Mike', 'Alex'];

    const mainModel = this.modelGateway.createDeterministicModel([
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
    ]);

    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      systemPrompt: 'You are Mike, the team coordinator. Make a build plan, then wait for approval.',
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'plan', label: 'Mike 出计划' });
    const result = await agent.invoke({ messages: [new HumanMessage(`出计划：${input}`)] });
    const plan = this.extractJsonFromMessages(result.messages as any[]);
    this.updateRun(runId, {
      status: 'awaiting_plan',
      template_id: templateId,
      plan_json: plan ? JSON.stringify(plan) : null,
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'plan' });
  }

  /**
   * Stage A：需求 + 架构 → 等架构审批。
   * Team Mode 开：Iris+Emma 合并出需求 → Bob 出架构（设计是架构输出的一部分）。
   * Team Mode 关：Mike 一人做匹配 + 需求 + 架构，Alex 只在 Stage B 出现。
   */
  private async executeStageA(runId: string, input: string, templateId: string, teamMode: boolean): Promise<void> {
    if (!teamMode) return this.executeStageASimple(runId, input, templateId);

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

    const bob = subAgent({
      name: 'bob',
      description: 'Architecture: module split, storage, tool contracts, and design notes.',
      systemPrompt: 'You are Bob, the architect. First call read_template, then output the architecture decision as JSON, including design notes.',
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
              design: {
                layout: '生成出来的应用占主要位置，时间线收进右侧边栏',
                tokens: { primary: '#2563eb', surface: '#ffffff', muted: '#f5f5f4' },
                notes: ['卡片标题加粗，元信息灰色小字', '操作按钮放卡片底部', '移动端单列，不横向溢出'],
              },
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
        type: 'tool',
        name: 'task',
        args: (history) => ({
          description: `为模板 ${templateIdFrom(history)} 出架构决策（含设计说明），先调用 read_template。`,
          subagent_type: 'bob',
        }),
      },
      { type: 'text', text: 'stage A done: requirements and architecture ready for review' },
    ]);

    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      subagents: [irisEmma, bob],
      systemPrompt: 'You are Mike, the team coordinator. Delegate to subagents, then summarize.',
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'A', label: '需求 + 架构' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成应用：${input}`)] });
    const taskResults = this.extractTaskResults(result.messages as any[]);
    const requirements = taskResults.iris_emma ?? null;
    const architecture = taskResults.bob ?? null;
    this.updateRun(runId, {
      status: 'awaiting_architecture',
      template_id: templateId,
      requirements_json: requirements ? JSON.stringify(requirements) : null,
      design_json: architecture?.design ? JSON.stringify(architecture.design) : null,
      architecture_json: architecture ? JSON.stringify(architecture) : null,
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'architecture' });
  }

  /** Stage A 简化版（Team Mode 关）：Mike 一人做匹配、需求、架构，不派 subagents。 */
  private async executeStageASimple(runId: string, input: string, templateId: string): Promise<void> {
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);
    const template = this.templates.get(templateId as TemplateId)!;

    const mainModel = this.modelGateway.createDeterministicModel([
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
          const t = this.templates.get(tid as TemplateId);
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
    ]);

    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      systemPrompt: 'You are Mike, the team coordinator. Match the template, read it, then write requirements and architecture.',
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'A', label: '需求 + 架构（简化）' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成应用：${input}`)] });
    const out = this.extractJsonFromMessages(result.messages as any[]) ?? {};
    this.updateRun(runId, {
      status: 'awaiting_architecture',
      template_id: templateId,
      requirements_json: out.requirements
        ? JSON.stringify({ templateId: out.templateId ?? templateId, requirements: out.requirements })
        : null,
      design_json: out.architecture?.design ? JSON.stringify(out.architecture.design) : null,
      architecture_json: out.architecture ? JSON.stringify(out.architecture) : null,
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'architecture' });
  }

  /** Engineer 模式：只派 Alex 一人——匹配、生成草稿、自检一次做完，等架构审批。 */
  private async executeEngineer(runId: string, input: string, templateId: string): Promise<void> {
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);
    const template = this.templates.get(templateId as TemplateId)!;
    const appName = `${template.name} · ${input.slice(0, 12)}`;

    const alex = subAgent({
      name: 'alex',
      description: 'Development: match, assemble the app draft from the template and self-check it.',
      systemPrompt: 'You are Alex, the developer. Call match_template, then save_draft, then validate_schema, then summarize.',
      mode: 'isolated',
      middleware: [middleware],
      tools: [tools.matchTemplate, tools.saveDraft, tools.validateSchema],
      model: this.modelGateway.createDeterministicModel([
        { type: 'tool', name: 'match_template', args: () => ({ input }) },
        {
          type: 'tool',
          name: 'save_draft',
          args: () => ({ templateId, name: appName, data: this.templates.seedData(templateId as TemplateId) }),
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
        args: () => ({ description: `用户需求：${input}。只派 Alex：匹配模板、生成草稿、自检。`, subagent_type: 'alex' }),
      },
      { type: 'text', text: 'engineer mode done: draft generated and self-checked' },
    ]);

    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      subagents: [alex],
      systemPrompt: 'You are Mike, the team coordinator. Delegate everything to Alex, then summarize.',
    });

    this.hub.emit(runId, 'stage_started', 'Alex', { stage: 'engineer', label: 'Alex 一人构建' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成应用：${input}`)] });
    const taskResults = this.extractTaskResults(result.messages as any[]);
    const draftRow = this.db.get<{ id: string; data_json: string }>(
      'SELECT id, data_json FROM drafts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
      runId,
    );
    this.updateRun(runId, {
      status: 'awaiting_architecture',
      template_id: templateId,
      requirements_json: JSON.stringify({
        templateId,
        requirements: [`创建「${template.name}」应用，支持查看与编辑`, '数据保存到后端，刷新后还在'],
      }),
      architecture_json: JSON.stringify({
        templateId,
        storage: 'apps 表，data_json 字段；草稿先写 drafts 表，审批通过后转正',
        tools: ['match_template', 'save_draft', 'validate_schema'],
        approvals: ['architecture', 'publish'],
        builtBy: 'alex',
        mode: 'engineer',
      }),
      draft_json: draftRow
        ? JSON.stringify({ draftId: draftRow.id, templateId, name: appName, data: JSON.parse(draftRow.data_json), alex: taskResults.alex ?? null })
        : null,
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'architecture' });
  }

  /** Stage B：Alex 生成草稿并自检（冒烟自检是构建环节里的步骤）→ 等发布审批。 */
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

  /**
   * 发布：Mike 直接调 check_health 做发布前检查 → 落盘成正式应用（上线 v1，
   * published_json 是线上快照）→ 冒烟 + 评估异步跑，不堵发布返回。
   */
  private async executePublish(runId: string): Promise<void> {
    const run = this.getRun(runId);
    const draft = JSON.parse(run.draft_json ?? '{}');
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);

    const mainModel = this.modelGateway.createDeterministicModel([
      { type: 'tool', name: 'check_health', args: () => ({}) },
      { type: 'text', text: 'health ok, ready to publish' },
    ]);
    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      systemPrompt: 'You are Mike, the team coordinator.',
    });
    await agent.invoke({ messages: [new HumanMessage('publish checks')] });

    const appId = randomUUID();
    const now = new Date().toISOString();
    const dataJson = JSON.stringify(draft.data ?? {});
    this.db.run(
      'INSERT INTO apps (id, name, template_id, data_json, published_json, published_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      appId,
      draft.name ?? '未命名应用',
      draft.templateId,
      dataJson,
      dataJson,
      1,
      now,
      now,
    );
    this.updateRun(runId, { status: 'published', app_id: appId });
    this.hub.emit(runId, 'app_published', 'Mike', { appId });

    // 冒烟 + 评估：异步跑，不堵发布返回。评估是产品功能，不挂人名。
    void this.executeReview(runId, appId).catch(() => undefined);
  }

  private async executeReview(runId: string, appId: string): Promise<void> {
    const { middleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);

    const mainModel = this.modelGateway.createDeterministicModel([
      { type: 'tool', name: 'run_smoke_tests', args: () => ({ appId }) },
      { type: 'tool', name: 'compute_eval', args: () => ({ runId }) },
      { type: 'text', text: 'review done' },
    ]);
    const agent = createDeepAgent({
      model: mainModel,
      tools: toolList,
      middleware: [middleware],
      systemPrompt: 'You are Mike, the team coordinator. Run the smoke tests, then compute the evaluation score.',
    });
    await agent.invoke({ messages: [new HumanMessage('post-publish review')] });
    const ev = this.evalService.latest(runId);
    this.hub.emit(runId, 'eval_ready', '评估', ev);
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

  /** 从消息历史里取最后一条 AI 文本消息，解析成 JSON；解析失败返回 null。 */
  private extractJsonFromMessages(messages: any[]): any | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const type = m.getType?.() ?? m.type;
      if (type === 'ai' && typeof m.content === 'string' && m.content.trim().startsWith('{')) {
        try {
          return JSON.parse(m.content);
        } catch {
          return null;
        }
      }
    }
    return null;
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
