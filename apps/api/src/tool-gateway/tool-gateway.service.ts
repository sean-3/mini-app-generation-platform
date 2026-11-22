import { Injectable } from '@nestjs/common';
import { createMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import type { z } from 'zod';

export interface GatewayTrace {
  tool: string;
  step: string;
  outcome: 'ok' | 'blocked';
  durationMs: number;
  detail?: string;
}

export interface GatewayResult {
  ok: boolean;
  /** ToolMessage content when ok; error payload when blocked. */
  content: string;
  step?: string;
  isError?: boolean;
  /** The handler's raw return value (ToolMessage or Command) for passthrough. */
  raw?: unknown;
}

export interface GatewayPolicy {
  /** Tools that exist in the registry. Anything else is blocked at the registry step. */
  allowedTools: Set<string>;
  /** Tools denied by permission policy (write-file ops in this demo). */
  deniedTools: Set<string>;
  /** Max tool calls per run (step budget). */
  maxSteps: number;
  /** Same tool + same args N times in a row -> block and open the circuit breaker. */
  maxRepeats: number;
  /** Consecutive identical results N times -> stop with partial results. */
  maxNoProgress: number;
  /** Per-call execution timeout (ms). */
  timeoutMs: number;
}

export const DEFAULT_POLICY: GatewayPolicy = {
  allowedTools: new Set([
    'task',
    'match_template',
    'read_template',
    'save_draft',
    'validate_schema',
    'export_json',
    'export_file',
    'run_smoke_tests',
    'compute_eval',
    'check_health',
    'list_apps',
  ]),
  deniedTools: new Set(['export_file']),
  maxSteps: 25,
  maxRepeats: 3,
  maxNoProgress: 3,
  timeoutMs: 10_000,
};

/**
 * Tool Gateway，按 Pi 的五步流程实现（参考实现，不复用 Pi 代码）：
 * ① 参数预处理 → ② Schema 校验 → ③ 权限拦截 → ④ 执行 → ⑤ 结果后处理。
 * 任何一步失败都编成 { isError: true } 的结果返回，永不抛出。
 * 兜底：步数预算、重复调用检测、熔断、无进展停止。
 */
export class ToolGateway {
  private calls = 0;
  private repeatCount = 0;
  private lastCallKey = '';
  private lastResultHash = '';
  private noProgressCount = 0;
  private circuitOpen = false;
  private traces: GatewayTrace[] = [];

  constructor(
    private readonly policy: GatewayPolicy = DEFAULT_POLICY,
    private readonly onTrace?: (t: GatewayTrace) => void,
  ) {}

  get isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  get callCount(): number {
    return this.calls;
  }

  get gatewayTraces(): GatewayTrace[] {
    return this.traces;
  }

  private record(t: GatewayTrace) {
    this.traces.push(t);
    this.onTrace?.(t);
  }

  private block(step: string, tool: string, message: string, started: number = Date.now()): GatewayResult {
    const durationMs = Date.now() - started;
    this.record({ tool, step, outcome: 'blocked', durationMs, detail: message });
    return {
      ok: false,
      isError: true,
      step,
      content: JSON.stringify({ isError: true, step, tool, message }),
    };
  }

  /**
   * Run one tool call through the five steps.
   * @param toolName tool being called
   * @param rawArgs raw arguments from the model
   * @param schema the tool's Zod schema (undefined for tools without one, e.g. task)
   * @param exec the real execution; only invoked if steps 1-3 pass.
   *   Returns { content } for bookkeeping plus the raw handler return
   *   (ToolMessage or Command) so the middleware can pass Commands through
   *   untouched — Commands carry state updates (e.g. subagent results).
   */
  async execute(
    toolName: string,
    rawArgs: Record<string, unknown>,
    schema: z.ZodType<any> | undefined,
    exec: (args: Record<string, unknown>) => Promise<{ content: string; raw?: unknown }>,
  ): Promise<GatewayResult> {
    const started = Date.now();

    // 熔断已开：直接拒绝，不再执行。
    if (this.circuitOpen) {
      return this.block('circuit_breaker', toolName, 'Circuit breaker is open: repeated failures, run stopped with partial results.');
    }

    // 步数预算
    if (this.calls >= this.policy.maxSteps) {
      return this.block('step_budget', toolName, `Step budget of ${this.policy.maxSteps} tool calls reached; stopping with partial results.`);
    }

    // ① 参数预处理：补默认值在 schema 层做；这里只做类型修正与截断。
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawArgs ?? {})) {
      if (typeof v === 'string') {
        const trimmed = v.trim();
        // 数字型字符串转数字（模型常把数字写成字符串）
        if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
          args[k] = Number(trimmed);
        } else {
          args[k] = trimmed.slice(0, 2000);
        }
      } else {
        args[k] = v;
      }
    }

    // ② Schema 校验（Zod，工具自带 schema）
    if (schema && typeof (schema as any).safeParse === 'function') {
      const parsed = (schema as any).safeParse(args);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i: any) => `${i.path.join('.')} ${i.message}`)
          .join('; ');
        return this.block('schema_validation', toolName, `Schema validation failed: ${detail}`);
      }
      Object.assign(args, parsed.data);
    }

    // 注册表：未注册的工具不允许调用
    if (!this.policy.allowedTools.has(toolName)) {
      return this.block('registry', toolName, `Tool ${toolName} is not registered in the gateway.`);
    }

    // ③ 权限拦截：读/写/删分级；deniedTools 直接拒绝
    if (this.policy.deniedTools.has(toolName)) {
      return this.block(
        'permission',
        toolName,
        `${toolName} requires file-write permission; the current role is read-only. Use export_json instead.`,
      );
    }

    // 重复调用检测：同一工具 + 同一参数连续出现 maxRepeats 次 -> 告警并熔断
    const callKey = `${toolName}:${JSON.stringify(args)}`;
    if (callKey === this.lastCallKey) {
      this.repeatCount += 1;
    } else {
      this.repeatCount = 1;
      this.lastCallKey = callKey;
    }
    if (this.repeatCount >= this.policy.maxRepeats) {
      this.circuitOpen = true;
      return this.block(
        'repeat_call',
        toolName,
        `Same tool call repeated ${this.repeatCount} times (${toolName}); stopping to avoid an infinite loop.`,
      );
    }

    // ④ 执行（带超时）
    this.calls += 1;
    let execOut: { content: string; raw?: unknown };
    try {
      execOut = await Promise.race([
        exec(args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`tool ${toolName} timed out after ${this.policy.timeoutMs}ms`)), this.policy.timeoutMs),
        ),
      ]);
    } catch (err: any) {
      // 执行异常也编成 isError 消息，不抛出
      return this.block('execution', toolName, `Tool execution failed: ${err?.message ?? String(err)}`);
    }
    const raw = execOut.content;

    // 无进展检测：连续相同结果 -> 带阶段性结果停下
    // streak 从 1 开始计：第一次出现即 1，连续第 maxNoProgress 次相同结果时触发。
    const hash = raw.length > 200 ? raw.slice(0, 200) : raw;
    if (hash === this.lastResultHash) {
      this.noProgressCount += 1;
    } else {
      this.noProgressCount = 1;
      this.lastResultHash = hash;
    }
    if (this.noProgressCount >= this.policy.maxNoProgress) {
      this.record({ tool: toolName, step: 'no_progress', outcome: 'blocked', durationMs: Date.now() - started, detail: 'no new information for 3 consecutive calls' });
      return {
        ok: true,
        content: JSON.stringify({
          isError: true,
          step: 'no_progress',
          tool: toolName,
          message: 'No new information for 3 consecutive calls; stopping with partial results.',
          partial: raw.slice(0, 2000),
        }),
        raw: execOut.raw,
      };
    }

    // ⑤ 结果后处理：截断大结果，记耗时
    const durationMs = Date.now() - started;
    const content = raw.length > 4000 ? raw.slice(0, 4000) + '\n…[truncated by gateway]' : raw;
    this.record({ tool: toolName, step: 'executed', outcome: 'ok', durationMs });
    return { ok: true, content, raw: execOut.raw };
  }
}

/**
 * 把 ToolGateway 接成 DeepAgents middleware（wrapToolCall）。
 * 拦截成功时直接返回 isError ToolMessage，不调用 handler，工具函数一次都不执行。
 * 注意：`task` 这类工具返回的是 LangGraph Command（携带状态更新，
 * 其中嵌着真正的 ToolMessage）。Command 必须原样透传，不能只取 .content，
 * 否则子 Agent 的结果会丢（Command 没有 .content，取到的会是空字符串）。
 */
export function createToolGatewayMiddleware(gateway: ToolGateway) {
  return createMiddleware({
    name: 'ToolGateway',
    wrapToolCall: async (request: any, handler: any) => {
      const toolName: string = request.tool?.name ?? request.toolCall.name;
      const schema = request.tool?.schema as z.ZodType<any> | undefined;
      const result = await gateway.execute(toolName, request.toolCall.args ?? {}, schema, async (args) => {
        const res = await handler({ ...request, toolCall: { ...request.toolCall, args } });
        if (res && typeof res === 'object' && 'update' in res) {
          // Command: 从 update 里取出 ToolMessage 的内容，raw 原样透传。
          const msgs = (res as any).update?.messages ?? [];
          const tm = msgs.find((m: any) => m?.getType?.() === 'tool') ?? msgs[0];
          const content = typeof tm?.content === 'string' ? tm.content : JSON.stringify(tm?.content ?? '');
          return { content, raw: res };
        }
        const content = typeof res?.content === 'string' ? res.content : JSON.stringify(res?.content ?? '');
        return { content, raw: res };
      });
      if (!result.ok) {
        return new ToolMessage({
          content: result.content,
          tool_call_id: request.toolCall.id,
          status: 'error',
        });
      }
      // Command 透传；普通 ToolMessage 按网关后处理后的内容重建。
      if (result.raw && typeof result.raw === 'object' && 'update' in (result.raw as any)) {
        return result.raw as any;
      }
      return new ToolMessage({
        content: result.content,
        tool_call_id: request.toolCall.id,
        status: 'success',
      });
    },
  });
}

@Injectable()
export class ToolGatewayService {
  /** 每轮 run 一个独立的网关实例（预算、重复计数、熔断按 run 隔离）。 */
  createGateway(onTrace?: (t: GatewayTrace) => void): ToolGateway {
    return new ToolGateway(DEFAULT_POLICY, onTrace);
  }
}
