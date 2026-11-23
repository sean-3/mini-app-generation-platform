import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createDeepAgent, createSubAgent } from 'deepagents';
import { createMiddleware, todoListMiddleware } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../persistence/database.service';
import { TemplatesService, type TemplateId } from '../templates/templates.service';
import { ModelGatewayService } from '../model-gateway/model-gateway.service';
import { ToolGatewayService, createToolGatewayMiddleware, type GatewayTrace } from '../tool-gateway/tool-gateway.service';
import { buildTools } from './tools';
import { EvalService } from '../eval/eval.service';
import { RunEventHub } from './run-hub';
import { parseJsonLoose } from '../common/json';

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
  usage_json: string | null;
  /** @ 指定的人名（Mike/Iris/Emma/Bob/Alex 之一），仅作提示，不改路由；没 @ 就是 null。 */
  mentioned_agent: string | null;
  created_at: string;
  updated_at: string;
}

/** 可被 @ 的 5 个人（和前端 AGENTS 列表一致）。 */
export const MENTIONABLE_AGENTS = ['Mike', 'Iris', 'Emma', 'Bob', 'Alex'] as const;

/** @ 提示进 system prompt 的一句：只作提示，路由仍按所选模式走。 */
function mentionLine(mentionedAgent: string | null): string {
  if (!mentionedAgent) return '';
  return `\nNote: the user mentioned @${mentionedAgent} for this run. Treat it as a hint only — routing still follows the selected mode (Build/Plan/Engineer + Team Mode).`;
}

// deepagents 1.17.0：传给 createDeepAgent 的 subagents 必须是原始 spec 对象，
// 不能传 createSubAgent 编译后的 ReactAgent——编译产物没有 .name，
// 框架在 getSubagents 里按 agentParams.name 去重会报 `Duplicate subagent name 'undefined'`。
// 这里直接返回 spec，让框架内部编译。
const subAgent = (spec: Parameters<typeof createSubAgent>[0]) => spec as any;

/** 自定义工具全集（主 Agent 协调时可用；子 Agent 只拿自己那几个）。 */
const ALL_CUSTOM_TOOLS = [
  'match_template',
  'read_template',
  'save_draft',
  'validate_schema',
  'export_json',
  'run_smoke_tests',
  'compute_eval',
  'check_health',
  'list_apps',
  'task',
];

/**
 * 各阶段系统提示共用的工具规则。线上实测（run df4df137）里模型调了不存在的
 * ls / glob / grep，被网关拦下后不收手、换别的工具继续试，save_draft 重复
 * 调了 4 次，run 卡在 generating。三道防线：
 * 1) harness profile 已把文件系统工具从 Agent 的工具列表里拿掉（只剩框架
 *    强制保留的 read_file）；2) 这里再写明禁掉和出错后的规矩；3) 网关注册表
 *    拦下时的消息也写明别换工具试。
 */
function toolRules(tools: string[]): string {
  return (
    '\nTool rules:\n' +
    `- The ONLY tools that exist in this environment are: ${tools.join(', ')} (plus write_todos for planning). ` +
    'There is no filesystem and no shell: ls, read_file, write_file, edit_file, delete, glob, grep, execute do not exist. Never call them, never look for files.\n' +
    '- Follow the numbered steps in order, each exactly once. No extra exploration.\n' +
    '- If a tool call returns {"isError": true, ...}: do NOT switch to a different tool. Either retry the SAME call once with corrected arguments, or finish with the results you already have and output the final JSON. Never retry the same failed call more than once. Never call save_draft twice with the same arguments.\n'
  );
}

/** 每个阶段的模型上下文：给单测的确定性剧本定位用，也写进 system prompt 的事实。 */
interface PhaseCtx {
  input: string;
  templateId: string;
  teamMode: boolean;
  appName?: string;
  appId?: string;
  runId?: string;
}

/**
 * Agent 编排 v4：真 Agent 循环。
 * 每个阶段都是一次 DeepAgents 调用，模型是 Kimi kimi-k3（Moonshot 国内站），
 * 工具调用顺序、次数、什么时候停都由模型自己决定；system prompt 只给角色、
 * 可用工具和最终输出的 JSON 契约。单测用确定性模型走同一套阶段代码。
 *
 * 团队按 atoms.dev 的 5 个构建角色来：
 * Mike（协调 + 审批对接人）、Iris（调研）、Emma（规格）、Bob（架构，设计是架构输出的一部分）、
 * Alex（构建，冒烟自检是构建环节里的步骤）。没有测试、运维、UI 设计师、复盘这几个独立角色；
 * 冒烟 + 评估是产品功能，不挂人名。
 *
 * 三种启动方式（Build / Plan / Engineer）+ Team Mode 开关：
 * - Build：直接开工。Team Mode 开 = 完整 5 人流程；关 = Mike + Alex 简化流程。
 *   默认关，对应 Atoms 实测：默认只有 Alex 一个人干活。
 * - Plan：Mike 先出计划，用户批准才开工；拒绝回退。
 * - Engineer：只派 Alex 一人干活（轻量模式），Team Mode 对它无效。
 *
 * 审批是两道（架构确认、发布确认），Plan 模式多一道计划确认作为入口。
 * 两道审批用自维护状态机实现，不用 LangGraph interrupt_on：审批是阶段之间的
 * UI 门，不是工具调用门；状态机更简单、可测试，轨迹里照样留痕。
 * （interrupt_on 是工具调用门，拦不住“阶段结束等用户点确认”这个需求。）
 *
 * 规划用 DeepAgents 自带的 write_todos（todoListMiddleware），模型自己决定
 * 要不要列计划；网关的 allowedTools 里放行了 write_todos。
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

  createRun(input: string, opts: { mode?: RunMode; teamMode?: boolean; mentionedAgent?: string } = {}): RunRow {
    const mode: RunMode = opts.mode === 'plan' || opts.mode === 'engineer' ? opts.mode : 'build';
    // Engineer 模式只派 Alex，Team Mode 对它无效。
    const teamMode = mode === 'engineer' ? false : opts.teamMode === true;
    // @ 只认 5 个人名，其他值一律忽略（不存、不提示）。
    const mentionedAgent = (MENTIONABLE_AGENTS as readonly string[]).includes(opts.mentionedAgent ?? '') ? opts.mentionedAgent! : null;
    // 没有 key 不创建 run、不跑流程：直接报明确错误，绝不用假模型冒充。
    if (!this.modelGateway.isTestMode() && !this.modelGateway.hasCloudModel()) {
      throw new BadRequestException(
        'MOONSHOT_API_KEY 未设置：请设置环境变量 MOONSHOT_API_KEY（Moonshot 国内站 platform.moonshot.cn 的 key），否则无法创建 run。',
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO runs (id, input, status, mode, team_mode, mentioned_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input,
      'running',
      mode,
      teamMode ? 1 : 0,
      mentionedAgent,
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

  /**
   * 重复调用演示：不走模型，直接调网关 3 次发起同一工具调用，
   * 第 3 次被重复检测拦截并熔断。演示的是网关本身，不是模型行为。
   */
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
    const { gateway, tools } = this.buildAgentParts(runId);
    const schema = (tools.matchTemplate as any).schema;
    for (let i = 0; i < 3; i++) {
      const res = await gateway.execute('match_template', { input }, schema, async (args) => {
        const out: any = await (tools.matchTemplate as any).invoke(args);
        return { content: typeof out === 'string' ? out : JSON.stringify(out) };
      });
      if (!res.ok) break; // 第 3 次被 repeat_call 拦截，熔断打开
    }
    this.updateRun(runId, { status: 'stopped' });
    this.hub.emit(runId, 'run_stopped', 'Mike', { reason: 'repeat_call', circuitOpen: gateway.isCircuitOpen });
  }

  /** Plan 模式：Mike 先出计划（目标、模板、步骤、参与的人、三道审批），等用户批准。 */
  private async executePlan(runId: string, input: string, templateId: string, teamMode: boolean): Promise<void> {
    const { middleware, usageMiddleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);
    const template = this.templates.get(templateId as TemplateId)!;
    const team = teamMode ? ['Mike', 'Iris', 'Emma', 'Bob', 'Alex'] : ['Mike', 'Alex'];

    const agent = createDeepAgent({
      model: this.modelGateway.createModel('plan', { input, templateId, teamMode, templates: this.templates }),
      tools: toolList,
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      systemPrompt:
        'You are Mike, the coordinator of a 5-person app-building team (Iris research, Emma PM, Bob architect, Alex developer; you coordinate).\n' +
        'Phase: make a build plan for the user request.\n' +
        '1) Call match_template with the user request to confirm which of the four templates fits.\n' +
        '2) Call read_template for that template.\n' +
        '3) Reply with ONLY a JSON object, no other text, no markdown fences:\n' +
        '{"goal": "<user request>", "templateId": "<one of ledger|habit|quote|signup>", "templateName": "<template name>", ' +
        '"steps": ["调研","规格","架构","构建","发布"], "team": ["Mike","Iris","Emma","Bob","Alex"] or ["Mike","Alex"], ' +
        '"approvals": ["计划","架构","发布"], "notes": ["<short note>", ...]}\n' +
        'If match_template returns templateId null, the request is outside the four templates: ' +
        'reply with ONLY {"templateId": null, "reason": "<why it does not fit>"} and stop.' +
        mentionLine(this.getRun(runId).mentioned_agent) +
        toolRules(['match_template', 'read_template']),
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'plan', label: 'Mike 出计划' });
    const result = await agent.invoke({ messages: [new HumanMessage(`出计划：${input}。本地规则初步匹配：${template.name}（${templateId}），如你的判断不同，以你的判断为准。`)] });
    const plan = this.extractJsonFromMessages(result.messages as any[]);
    if (!plan || typeof plan.templateId !== 'string' || !this.templates.get(plan.templateId)) {
      this.failRun(runId, `模型未输出有效计划 JSON（templateId 缺失或不在四个模板内），停下。`);
      return;
    }
    this.updateRun(runId, {
      status: 'awaiting_plan',
      template_id: templateId,
      plan_json: JSON.stringify({ ...plan, team }),
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

    const { middleware, usageMiddleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);

    const irisEmma = subAgent({
      name: 'iris_emma',
      description: 'Research the request and write the requirements list.',
      systemPrompt:
        'You are Iris (research) + Emma (PM).\n' +
        '1) Call match_template with the user request from the task description.\n' +
        '2) Reply with ONLY a JSON object, no other text, no markdown fences:\n' +
        '{"templateId": "<one of ledger|habit|quote|signup>", "confidence": <0-1>, ' +
        '"requirements": ["<requirement>", ...]}\n' +
        'Requirements must cover: what the app does, data persists in the backend after refresh, ' +
        'field validation, empty and error states.' +
        toolRules(['match_template']),
      mode: 'isolated',
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      tools: [tools.matchTemplate],
      model: this.modelGateway.createModel('stageA-iris-emma', { input, templateId, teamMode, templates: this.templates }),
    });

    const bob = subAgent({
      name: 'bob',
      description: 'Architecture: module split, storage, tool contracts, and design notes.',
      systemPrompt:
        'You are Bob, the architect.\n' +
        '1) Call read_template with the templateId from the requirements.\n' +
        '2) Reply with ONLY a JSON object, no other text, no markdown fences:\n' +
        '{"templateId": "<id>", "storage": "apps 表，data_json 字段；草稿先写 drafts 表，审批通过后转正", ' +
        '"tools": ["match_template","save_draft","validate_schema"], "approvals": ["architecture","publish"], ' +
        '"design": {"layout": "<where the app sits, where the timeline sits>", ' +
        '"tokens": {"primary": "#2563eb", "surface": "#ffffff", "muted": "#f5f5f4"}, "notes": ["<design note>", ...]}}' +
        toolRules(['read_template']),
      mode: 'isolated',
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      tools: [tools.readTemplate],
      model: this.modelGateway.createModel('stageA-bob', { input, templateId, teamMode, templates: this.templates }),
    });

    const agent = createDeepAgent({
      model: this.modelGateway.createModel('stageA-main', { input, templateId, teamMode, templates: this.templates }),
      tools: toolList,
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      subagents: [irisEmma, bob],
      systemPrompt:
        'You are Mike, the team coordinator. Delegate with the task tool, then summarize.\n' +
        '1) Use task to ask subagent iris_emma: research the request and write the requirements list (it calls match_template itself).\n' +
        '2) Use task to ask subagent bob: make the architecture decision including design notes (it calls read_template itself).\n' +
        '3) When both results are back, reply with ONLY the text: stage A done' +
        mentionLine(this.getRun(runId).mentioned_agent) +
        toolRules(ALL_CUSTOM_TOOLS),
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'A', label: '需求 + 架构' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成应用：${input}`)] });
    const taskResults = this.extractTaskResults(result.messages as any[]);
    const requirements = taskResults.iris_emma ?? null;
    const architecture = taskResults.bob ?? null;
    if (!requirements?.requirements?.length || !architecture?.templateId || !this.templates.get(architecture.templateId)) {
      this.failRun(runId, 'Stage A 未产出有效需求或架构（子 Agent 输出缺字段或模板不对），停下。');
      return;
    }
    this.updateRun(runId, {
      status: 'awaiting_architecture',
      template_id: templateId,
      requirements_json: JSON.stringify(requirements),
      design_json: architecture?.design ? JSON.stringify(architecture.design) : null,
      architecture_json: JSON.stringify(architecture),
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'architecture' });
  }

  /** Stage A 简化版（Team Mode 关）：Mike 一人做匹配、需求、架构，不派 subagents。 */
  private async executeStageASimple(runId: string, input: string, templateId: string): Promise<void> {
    const { middleware, usageMiddleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);

    const agent = createDeepAgent({
      model: this.modelGateway.createModel('stageA-simple', { input, templateId, teamMode: false, templates: this.templates }),
      tools: toolList,
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      systemPrompt:
        'You are Mike, the team coordinator. Do the requirements + architecture yourself.\n' +
        '1) Call match_template with the user request.\n' +
        '2) Call read_template with the matched templateId.\n' +
        '3) Reply with ONLY a JSON object, no other text, no markdown fences:\n' +
        '{"templateId": "<one of ledger|habit|quote|signup>", "requirements": ["<requirement>", ...], ' +
        '"architecture": {"templateId": "<id>", "storage": "apps 表，data_json 字段；草稿先写 drafts 表，审批通过后转正", ' +
        '"tools": ["match_template","save_draft","validate_schema"], "approvals": ["architecture","publish"], ' +
        '"design": {"layout": "<where the app sits, where the timeline sits>", "notes": ["<design note>", ...]}}}' +
        mentionLine(this.getRun(runId).mentioned_agent) +
        toolRules(['match_template', 'read_template']),
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'A', label: '需求 + 架构（简化）' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成应用：${input}`)] });
    const out = this.extractJsonFromMessages(result.messages as any[]) ?? {};
    if (!out.requirements?.length || !out.architecture?.templateId || !this.templates.get(out.architecture.templateId)) {
      this.failRun(runId, 'Stage A 未产出有效需求或架构（模型输出缺字段或模板不对），停下。');
      return;
    }
    this.updateRun(runId, {
      status: 'awaiting_architecture',
      template_id: templateId,
      requirements_json: JSON.stringify({ templateId: out.templateId ?? templateId, requirements: out.requirements }),
      design_json: out.architecture?.design ? JSON.stringify(out.architecture.design) : null,
      architecture_json: JSON.stringify(out.architecture),
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'architecture' });
  }

  /** Engineer 模式：只派 Alex 一人——匹配、生成草稿、自检一次做完，等架构审批。 */
  private async executeEngineer(runId: string, input: string, templateId: string): Promise<void> {
    const { middleware, usageMiddleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);
    const template = this.templates.get(templateId as TemplateId)!;
    const appName = `${template.name} · ${input.slice(0, 12)}`;

    const alex = subAgent({
      name: 'alex',
      description: 'Development: match, assemble the app draft from the template and self-check it.',
      systemPrompt:
        'You are Alex, the developer. Build the app draft and self-check it.\n' +
        '1) Call match_template with the user request.\n' +
        `2) Call save_draft with templateId and name "${appName}" (omit data to use the template default seed data). If you supply data, every signup must include slot (one of the three time options, matching the pickup time in the request) and items (what they ordered); do not invent other field names.\n` +
        '3) Call validate_schema with the draftId from step 2.\n' +
        '4) Reply with ONLY a JSON object, no other text, no markdown fences:\n' +
        '{"draftReady": <true if validate_schema says valid>, "valid": <bool>, "errors": [<strings>]}' +
        toolRules(['match_template', 'save_draft', 'validate_schema']),
      mode: 'isolated',
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      tools: [tools.matchTemplate, tools.saveDraft, tools.validateSchema],
      model: this.modelGateway.createModel('engineer-alex', { input, templateId, teamMode: false, appName, templates: this.templates }),
    });

    const agent = createDeepAgent({
      model: this.modelGateway.createModel('engineer-main', { input, templateId, teamMode: false, appName, templates: this.templates }),
      tools: toolList,
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      subagents: [alex],
      systemPrompt:
        'You are Mike, the team coordinator. Delegate everything to Alex, then summarize.\n' +
        'Use task to ask subagent alex to match the template, generate the draft and self-check it, ' +
        'then reply with ONLY the text: engineer mode done' +
        mentionLine(this.getRun(runId).mentioned_agent) +
        toolRules(ALL_CUSTOM_TOOLS),
    });

    this.hub.emit(runId, 'stage_started', 'Alex', { stage: 'engineer', label: 'Alex 一人构建' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成应用：${input}`)] });
    const taskResults = this.extractTaskResults(result.messages as any[]);
    const draftRow = this.db.get<{ id: string; data_json: string }>(
      'SELECT id, data_json FROM drafts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
      runId,
    );
    if (!draftRow) {
      this.failRun(runId, 'Engineer 模式未生成草稿（Alex 没调 save_draft 或保存失败），停下。');
      return;
    }
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
      draft_json: JSON.stringify({ draftId: draftRow.id, templateId, name: appName, data: JSON.parse(draftRow.data_json), alex: taskResults.alex ?? null }),
    });
    this.hub.emit(runId, 'approval_requested', 'Mike', { kind: 'architecture' });
  }

  /** Stage B：Alex 生成草稿并自检（冒烟自检是构建环节里的步骤）→ 等发布审批。 */
  private async executeStageB(runId: string): Promise<void> {
    const run = this.getRun(runId);
    const templateId = run.template_id as TemplateId;
    const template = this.templates.get(templateId)!;
    const { middleware, usageMiddleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);
    const appName = `${template.name} · ${run.input.slice(0, 12)}`;

    const alex = subAgent({
      name: 'alex',
      description: 'Development: assemble the app draft from the template and self-check it.',
      systemPrompt:
        'You are Alex, the developer.\n' +
        `1) Call save_draft with templateId "${templateId}" and name "${appName}" (omit data to use the template default seed data). If you supply data, every signup must include slot (one of the three time options, matching the pickup time in the request) and items (what they ordered); do not invent other field names.\n` +
        '2) Call validate_schema with the draftId from step 1.\n' +
        '3) Reply with ONLY a JSON object, no other text, no markdown fences:\n' +
        '{"draftReady": <true if validate_schema says valid>, "valid": <bool>, "errors": [<strings>]}' +
        toolRules(['save_draft', 'validate_schema']) +
        'Fixed order for this stage: save_draft once, then validate_schema once, then the final JSON. Nothing else.\n',
      mode: 'isolated',
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      tools: [tools.saveDraft, tools.validateSchema],
      model: this.modelGateway.createModel('stageB-alex', { input: run.input, templateId, teamMode: run.team_mode === 1, appName, templates: this.templates }),
    });

    const agent = createDeepAgent({
      model: this.modelGateway.createModel('stageB-main', { input: run.input, templateId, teamMode: run.team_mode === 1, appName, templates: this.templates }),
      tools: toolList,
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      subagents: [alex],
      systemPrompt:
        'You are Mike, the team coordinator. Delegate generation to Alex, then summarize.\n' +
        'Use task to ask subagent alex to generate the draft and self-check it, ' +
        'then reply with ONLY the text: stage B done' +
        toolRules(ALL_CUSTOM_TOOLS),
    });

    this.hub.emit(runId, 'stage_started', 'Mike', { stage: 'B', label: '开发：生成草稿' });
    const result = await agent.invoke({ messages: [new HumanMessage(`生成草稿：${appName}`)] });
    const taskResults = this.extractTaskResults(result.messages as any[]);
    const draftRow = this.db.get<{ id: string; data_json: string }>(
      'SELECT id, data_json FROM drafts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
      runId,
    );
    if (!draftRow) {
      this.failRun(runId, 'Stage B 未生成草稿（Alex 没调 save_draft 或保存失败），停下。');
      return;
    }
    this.updateRun(runId, {
      status: 'awaiting_publish',
      draft_json: JSON.stringify({ draftId: draftRow.id, templateId, name: appName, data: JSON.parse(draftRow.data_json), alex: taskResults.alex ?? null }),
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
    const { middleware, usageMiddleware, tools } = this.buildAgentParts(runId);
    const toolList = Object.values(tools);

    const agent = createDeepAgent({
      model: this.modelGateway.createModel('publish', { input: run.input, templateId: run.template_id ?? '', teamMode: false, templates: this.templates }),
      tools: toolList,
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      systemPrompt:
        'You are Mike, the team coordinator. Call check_health once, then reply with ONLY the text: health ok' +
        toolRules(['check_health']),
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
    const { middleware, usageMiddleware, tools } = this.buildAgentParts(runId, { appId });
    const toolList = Object.values(tools);

    const agent = createDeepAgent({
      model: this.modelGateway.createModel('review', { input: '', templateId: '', teamMode: false, appId, runId, templates: this.templates }),
      tools: toolList,
      middleware: [middleware, usageMiddleware, todoListMiddleware()],
      systemPrompt:
        'You are Mike, the team coordinator. Do these steps in order, each exactly once:\n' +
        '1. Call run_smoke_tests (no arguments — the published app is already bound).\n' +
        '2. Reply with ONLY the text: review done' +
        toolRules(['run_smoke_tests']),
    });
    try {
      await agent.invoke({ messages: [new HumanMessage('post-publish review')] });
    } finally {
      // 评估不交给模型调工具：线上实测 run 7f3dd1e3 里模型只调了 run_smoke_tests
      // 就收尾了，compute_eval 一次没调，回放 eval 一直是 null。改成服务端直接算分，
      // 不管 review agent 成败都落库（eval 只从 trace 算分，不依赖模型输出）。
      const started = Date.now();
      const ev = this.evalService.compute(runId);
      this.recordTrace(runId, 'Mike', 'tool', 'compute_eval', JSON.stringify({}), JSON.stringify(ev), false, Date.now() - started);
      this.hub.emit(runId, 'eval_ready', '评估', ev);
    }
  }

  // ---------------- helpers ----------------

  private buildAgentParts(runId: string, opts: { appId?: string } = {}) {
    const gateway = this.gatewayService.createGateway((t: GatewayTrace) => {
      this.recordTrace(runId, 'ToolGateway', 'tool', t.tool, null, JSON.stringify({ step: t.step, outcome: t.outcome, detail: t.detail }), t.outcome === 'blocked', t.durationMs);
      this.hub.emit(runId, 'tool', 'ToolGateway', t);
    });
    const middleware = createToolGatewayMiddleware(gateway);
    const usageMiddleware = this.createUsageMiddleware(runId);
    const tools = buildTools({ db: this.db, templates: this.templates, evalService: this.evalService, runId, appId: opts.appId });
    return { gateway, middleware, usageMiddleware, tools };
  }

  /**
   * token 用量中间件：每次模型调用返回后立刻把用量累计进 runs.usage_json。
   * 之前只在阶段结束时从消息历史里算一次，run 卡住时看不到烧了多少
   * （线上实测 run df4df137 卡在 Stage B 四分钟，usage 还是空的）。
   * 主 Agent 和子 Agent 的中间件栈里都挂了它，所以子 Agent 的调用也实时
   * 计入，不再是“下限”。这是用量唯一的写入者，阶段结束不再另算。
   */
  private createUsageMiddleware(runId: string) {
    return createMiddleware({
      name: 'UsageRecorder',
      wrapModelCall: async (request: any, handler: any) => {
        const res = await handler(request);
        const responses = Array.isArray(res) ? res : [res];
        for (const r of responses) {
          const u = (r as any)?.usage_metadata ?? (r as any)?.response_metadata?.tokenUsage;
          if (!u) continue;
          const prompt = u.input_tokens ?? u.prompt_tokens ?? 0;
          const completion = u.output_tokens ?? u.completion_tokens ?? 0;
          if (prompt > 0 || completion > 0) this.accumulateUsage(runId, prompt, completion, 1);
        }
        return res;
      },
    });
  }

  /** 累计一次模型调用的 token 用量，写进 runs.usage_json（唯一写入处）。 */
  private accumulateUsage(runId: string, promptTokens: number, completionTokens: number, modelCalls: number): void {
    const prev = this.parseUsage(this.getRun(runId).usage_json);
    this.updateRun(runId, {
      usage_json: JSON.stringify({
        promptTokens: prev.promptTokens + promptTokens,
        completionTokens: prev.completionTokens + completionTokens,
        totalTokens: prev.totalTokens + promptTokens + completionTokens,
        modelCalls: prev.modelCalls + modelCalls,
      }),
    });
  }

  /** 阶段失败：状态 stopped，留一条错误轨迹和停下事件，不进审批。 */
  private failRun(runId: string, message: string): void {
    this.updateRun(runId, { status: 'stopped' });
    this.recordTrace(runId, 'Mike', 'stage', null, null, JSON.stringify({ error: message }), true, 0);
    this.hub.emit(runId, 'run_stopped', 'Mike', { error: message });
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

  private parseUsage(json: string | null): { promptTokens: number; completionTokens: number; totalTokens: number; modelCalls: number } {
    const empty = { promptTokens: 0, completionTokens: 0, totalTokens: 0, modelCalls: 0 };
    if (!json) return empty;
    try {
      const p = JSON.parse(json);
      return { ...empty, ...p };
    } catch {
      return empty;
    }
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

  /**
   * 从消息历史里取最后一条 AI 文本消息，宽松解析成 JSON。
   * 真模型常把 JSON 包在 ```json 围栏里，先去围栏再解析；还不行就取首尾大括号之间的子串。
   * 解析失败返回 null，调用方按“阶段失败”停下，不带 null 继续走审批。
   */
  private extractJsonFromMessages(messages: any[]): any | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const type = m.getType?.() ?? m.type;
      if (type === 'ai' && typeof m.content === 'string' && m.content.trim()) {
        const parsed = parseJsonLoose(m.content);
        if (parsed) return parsed;
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
        out[name] = parseJsonLoose(content) ?? { raw: content };
      }
    }
    return out;
  }
}
