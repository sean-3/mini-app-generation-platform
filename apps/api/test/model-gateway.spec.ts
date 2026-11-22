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

  it('cloud slot: throws a clear error when not configured', () => {
    expect(() => svc.createCloudModel()).toThrow(/not configured/);
    expect(svc.hasCloudModel()).toBe(false);
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
