import { ModelGatewayService } from '../src/model-gateway/model-gateway.service';
import { DeterministicModel, type PlanStep } from '../src/model-gateway/deterministic-model';
import { TemplatesService } from '../src/templates/templates.service';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';

describe('ModelGatewayService', () => {
  const svc = new ModelGatewayService(new TemplatesService());

  it('routeLocal: keyword input matches locally without a model', () => {
    expect(svc.routeLocal('小区团购接龙').templateId).toBe('signup');
    expect(svc.routeLocal('在线商城').templateId).toBeNull();
  });

  it('cloud model: clear MOONSHOT_API_KEY error without a key', () => {
    delete process.env.MOONSHOT_API_KEY;
    expect(svc.hasCloudModel()).toBe(false);
    expect(() => svc.createCloudModel()).toThrow(/MOONSHOT_API_KEY/);
    expect(() => svc.createModel('plan', { input: 'x', templateId: 'signup', teamMode: false })).toThrow(/MOONSHOT_API_KEY/);
  });

  it('cloud model: with a key it is ChatOpenAI kimi-k3 on the Moonshot China station', () => {
    process.env.MOONSHOT_API_KEY = 'sk-test-key';
    try {
      expect(svc.hasCloudModel()).toBe(true);
      const model: any = svc.createCloudModel();
      expect(model.model).toBe('kimi-k3');
      expect(model.clientConfig?.baseURL ?? model.clientConfig?.baseUrl).toBe('https://api.moonshot.cn/v1');
      const viaGateway: any = svc.createModel('plan', { input: 'x', templateId: 'signup', teamMode: false });
      expect(viaGateway.model).toBe('kimi-k3');
    } finally {
      delete process.env.MOONSHOT_API_KEY;
    }
  });

  it('test factory: when given, createModel returns the factory model instead of the cloud model', () => {
    delete process.env.MOONSHOT_API_KEY;
    const templates = new TemplatesService();
    const factory = new ModelGatewayService(templates, () => new DeterministicModel([{ type: 'text', text: 'factory' }]));
    expect(factory.isTestMode()).toBe(true);
    expect(factory.createModel('plan', {})).toBeInstanceOf(DeterministicModel);
    // 没有 key 也不会在测试模式下报错：测试工厂绕过了云端模型。
    expect(() => factory.createModel('plan', {})).not.toThrow();
  });

  it('deterministic model follows the scripted plan turn by turn', async () => {
    const plan: PlanStep[] = [
      { type: 'tool', name: 'add', args: () => ({ a: 1, b: 2 }) },
      { type: 'text', text: 'done' },
    ];
    const model = new DeterministicModel(plan);
    const bound = model.bindTools([{ name: 'add' } as any]);
    const r1: any = await bound.invoke([new HumanMessage('go')]);
    expect(r1.tool_calls?.[0]?.name).toBe('add');
    const r2: any = await bound.invoke([
      new HumanMessage('go'),
      r1,
      new ToolMessage({ content: '3', tool_call_id: r1.tool_calls[0].id }),
    ]);
    expect(r2.content).toBe('done');
  });
});
