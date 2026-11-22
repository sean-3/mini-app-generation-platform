import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/**
 * 确定性模型：实现 LangChain ChatModel 接口，返回按剧本编排的工具调用决策。
 * 它不是大模型——没有 key 时用它让 DeepAgents 的真实循环（规划、子 Agent、
 * 中间件、工具调用）完整跑起来；有 key 后只改 Model Gateway 这一处。
 */
export type PlanStep =
  | { type: 'tool'; name: string; args: (history: BaseMessage[]) => Record<string, unknown> }
  | {
      type: 'tools';
      calls: Array<{ name: string; args: (history: BaseMessage[]) => Record<string, unknown> }>;
    }
  | { type: 'text'; text: string | ((history: BaseMessage[]) => string) };

export function lastToolResult(history: BaseMessage[]): any | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m: any = history[i];
    if (m.getType?.() === 'tool' || m.type === 'tool') {
      try {
        return JSON.parse(typeof m.content === 'string' ? m.content : '{}');
      } catch {
        return { raw: m.content };
      }
    }
  }
  return null;
}

export function lastUserText(history: BaseMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m: any = history[i];
    if ((m.getType?.() === 'human' || m.type === 'human') && typeof m.content === 'string') {
      return m.content;
    }
  }
  return '';
}

export class DeterministicModel extends BaseChatModel {
  constructor(private readonly plan: PlanStep[]) {
    super({});
  }

  _llmType(): string {
    return 'deterministic';
  }

  /** Agent 框架要求模型实现 bindTools；按 FakeChatModel 的惯用做法返回同类新实例。 */
  bindTools(tools: any[]): any {
    const next = new DeterministicModel(this.plan);
    (next as any).tools = tools;
    return next;
  }

  async _generate(messages: BaseMessage[], _options: any): Promise<ChatResult> {
    // 按 AI 发言轮次取剧本步骤：并行工具调用一次产生多条 ToolMessage，
    // 用 ToolMessage 计数会跳号；AI 轮次计数对并行调用也稳定。
    const turn = messages.filter((m) => m.getType() === 'ai').length;
    const step: PlanStep = this.plan[turn] ?? { type: 'text', text: 'done' };
    let ai: AIMessage;
    // 固定 token 用量：让 usage 中间件在单测里也有东西可记（真模型由
    // ChatOpenAI 在 usage_metadata 里回真实数字，这里只是固定值）。
    const usage_metadata = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
    if (step.type === 'tool') {
      ai = new AIMessage({
        content: '',
        tool_calls: [{ id: `call_${turn + 1}_${step.name}`, name: step.name, args: step.args(messages) }],
        usage_metadata,
      });
    } else if (step.type === 'tools') {
      ai = new AIMessage({
        content: '',
        tool_calls: step.calls.map((c, i) => ({
          id: `call_${turn + 1}_${c.name}_${i}`,
          name: c.name,
          args: c.args(messages),
        })),
        usage_metadata,
      });
    } else {
      const text = typeof step.text === 'function' ? step.text(messages) : step.text;
      ai = new AIMessage({ content: text, usage_metadata });
    }
    return { generations: [{ text: typeof ai.content === 'string' ? ai.content : '', message: ai }] };
  }
}
