import { createDeepAgent, getHarnessProfile } from 'deepagents';
import { ChatOpenAI } from '@langchain/openai';
import { createMiddleware, tool } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
  EXCLUDED_FILESYSTEM_TOOLS,
  KIMI_MODEL_IDS,
  kimiHarnessProfile,
} from '../src/model-gateway/harness-profile';

function profileHas(profile: any, name: string): boolean {
  const excluded = profile?.excludedTools;
  if (!excluded) return false;
  if (Array.isArray(excluded)) return excluded.includes(name);
  return typeof excluded.has === 'function' ? excluded.has(name) : false;
}

describe('Kimi harness profile: filesystem tools off', () => {
  it('every verified Kimi model id excludes ls/glob/grep/write_file/edit_file/delete/execute', () => {
    for (const id of KIMI_MODEL_IDS) {
      const profile = kimiHarnessProfile(id);
      expect(profile).toBeDefined();
      for (const t of EXCLUDED_FILESYSTEM_TOOLS) {
        expect(profileHas(profile, t)).toBe(true);
      }
    }
  });

  it('the openai provider profile excludes them too (this is the layer that actually matches)', () => {
    // 当前 @langchain/openai 的 ChatOpenAI 的 model_name / modelName 都是
    // undefined，deepagents 按模型名查不到 profile，只按 provider 查。
    const profile = getHarnessProfile('openai');
    expect(profile).toBeDefined();
    for (const t of EXCLUDED_FILESYSTEM_TOOLS) {
      expect(profileHas(profile, t)).toBe(true);
    }
  });

  it('a real kimi-k3 agent does not offer ls/glob/grep to the model', async () => {
    // wrapModelCall 记下模型实际看到的工具列表，然后直接抛错——
    // 构造 Agent 和绑定工具都不需要联网，抛错拦在真正调模型之前。
    const seenTools: string[] = [];
    const probe = createMiddleware({
      name: 'ToolProbe',
      wrapModelCall: async (request: any) => {
        const tools = request.tools ?? [];
        for (const t of tools) {
          seenTools.push(t?.name ?? t?.function?.name ?? String(t));
        }
        throw new Error('probe-stop');
      },
    });
    const model = new ChatOpenAI({
      model: 'kimi-k3',
      apiKey: 'test-only-no-network',
      configuration: { baseURL: 'https://api.moonshot.cn/v1' },
    });
    const dummy = tool(async () => 'ok', {
      name: 'dummy_tool',
      description: 'test only',
      schema: z.object({}),
    });
    const agent = createDeepAgent({
      model,
      tools: [dummy as any],
      middleware: [probe as any],
      systemPrompt: 'test',
    });
    await expect(
      agent.invoke({ messages: [new HumanMessage('hi')] }),
    ).rejects.toThrow('probe-stop');
    expect(seenTools).toContain('dummy_tool');
    for (const t of ['ls', 'glob', 'grep', 'write_file', 'edit_file', 'delete', 'execute']) {
      expect(seenTools).not.toContain(t);
    }
  });
});
