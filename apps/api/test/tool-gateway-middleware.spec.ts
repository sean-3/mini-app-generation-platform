import { createDeepAgent } from 'deepagents';
import { tool } from 'langchain';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import { DeterministicModel } from '../src/model-gateway/deterministic-model';
import { ToolGatewayService, createToolGatewayMiddleware } from '../src/tool-gateway/tool-gateway.service';

/**
 * 网关中间件测试：模型在真 Agent 循环里发出的每一次工具调用都经过五步网关。
 * export_file 在默认策略的拒绝列表里，模型叫它也执行 0 次，模型看到的是
 * isError:true 的 ToolMessage，而不是异常或成功。
 */
describe('ToolGateway middleware inside a real DeepAgents loop', () => {
  const makeAgent = (model: DeterministicModel, tools: any[]) => {
    const gateway = new ToolGatewayService().createGateway();
    return createDeepAgent({
      model: model as any,
      tools,
      middleware: [createToolGatewayMiddleware(gateway)],
      systemPrompt: 'Call the tool once, then reply with ONLY the text: done',
    });
  };

  it('blocked call: export_file never executes (0 times) and the model sees isError:true', async () => {
    let executions = 0;
    const exportFile = tool(
      async () => {
        executions += 1;
        return 'written';
      },
      {
        name: 'export_file',
        description: 'Export an app to a file.',
        schema: z.object({ appId: z.string(), format: z.string() }),
      },
    );
    const model = new DeterministicModel([
      { type: 'tool', name: 'export_file', args: () => ({ appId: 'x', format: 'csv' }) },
      { type: 'text', text: 'done' },
    ]);
    const agent = makeAgent(model, [exportFile]);
    const result: any = await agent.invoke({ messages: [new HumanMessage('export the app')] });

    expect(executions).toBe(0);
    const toolMessages = result.messages.filter((m: any) => (m.getType?.() ?? m.type) === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    const payload = JSON.parse(toolMessages[0].content as string);
    expect(payload).toMatchObject({ isError: true, step: 'permission' });
  });

  it('allowed call: match_template passes the gateway and executes exactly once', async () => {
    let executions = 0;
    const matchTemplate = tool(
      async () => {
        executions += 1;
        return JSON.stringify({ templateId: 'signup', confidence: 0.9 });
      },
      {
        name: 'match_template',
        description: 'Match the user request to a template.',
        schema: z.object({ input: z.string() }),
      },
    );
    const model = new DeterministicModel([
      { type: 'tool', name: 'match_template', args: () => ({ input: '团购接龙' }) },
      { type: 'text', text: 'done' },
    ]);
    const agent = makeAgent(model, [matchTemplate]);
    const result: any = await agent.invoke({ messages: [new HumanMessage('match it')] });

    expect(executions).toBe(1);
    const toolMessages = result.messages.filter((m: any) => (m.getType?.() ?? m.type) === 'tool');
    expect(toolMessages[0].content).toContain('signup');
  });
});
