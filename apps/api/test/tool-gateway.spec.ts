import { z } from 'zod';
import { ToolGateway, DEFAULT_POLICY } from '../src/tool-gateway/tool-gateway.service';

const addSchema = z.object({ a: z.number(), b: z.number() });

// 'add' is a test-only tool: register it in the gateway policy for these unit tests.
const makeGateway = (overrides: Partial<import('../src/tool-gateway/tool-gateway.service').GatewayPolicy> = {}) =>
  new ToolGateway({ ...DEFAULT_POLICY, allowedTools: new Set([...DEFAULT_POLICY.allowedTools, 'add']), ...overrides });

describe('ToolGateway five steps', () => {
  it('step 1 preprocess: numeric strings are coerced to numbers', async () => {
    const g = makeGateway();
    const r = await g.execute('add', { a: '2', b: 3 }, addSchema, async (args) => ({ content: String((args.a as number) + (args.b as number)) }));
    expect(r.ok).toBe(true);
    expect(r.content).toBe('5');
  });

  it('step 2 schema: invalid args are blocked with isError:true and never executed', async () => {
    const g = makeGateway();
    let calls = 0;
    const exec = async () => { calls += 1; return { content: 'should not run' }; };
    const r = await g.execute('add', { a: 'not-a-number', b: 3 }, addSchema, exec);
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content)).toMatchObject({ isError: true, step: 'schema_validation' });
    expect(calls).toBe(0);
  });

  it('step 3 permission: export_file is denied without execution', async () => {
    const g = makeGateway();
    let calls = 0;
    const exec = async () => { calls += 1; return { content: 'written' }; };
    const r = await g.execute('export_file', { appId: 'x', format: 'csv' }, undefined, exec);
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content)).toMatchObject({ isError: true, step: 'permission' });
    expect(calls).toBe(0);
  });

  it('registry: unregistered tools are blocked', async () => {
    const g = makeGateway();
    let calls = 0;
    const exec = async () => { calls += 1; return { content: 'x' }; };
    const r = await g.execute('write_file', { path: '/tmp/x' }, undefined, exec);
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content)).toMatchObject({ isError: true, step: 'registry' });
    expect(calls).toBe(0);
  });

  it('registry block message tells the model not to try another tool instead', async () => {
    const g = makeGateway();
    const r = await g.execute('glob', { pattern: '**/*.ts' }, undefined, async () => ({ content: 'x' }));
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).message).toContain('Do not try another tool as a substitute');
  });

  it('per-tool timeout: task gets a longer budget than the 10s default', async () => {
    // task 是子代理派活，子代理内部还要调模型，10 秒必超时；300 秒是上限。
    const g = new ToolGateway({
      ...DEFAULT_POLICY,
      allowedTools: new Set([...DEFAULT_POLICY.allowedTools, 'add', 'task']),
      timeoutMs: 50,
      toolTimeouts: { task: 500 },
    });
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { content: 'slow ok' };
    };
    // 同样 200ms 的执行：task 在放宽后的预算内跑完，add 按默认预算超时。
    const taskRes = await g.execute('task', { description: 'x', subagent_type: 'alex' }, undefined, slow);
    expect(taskRes.ok).toBe(true);
    const addRes = await g.execute('add', { a: 1, b: 2 }, addSchema, slow);
    expect(addRes.ok).toBe(false);
    expect(JSON.parse(addRes.content)).toMatchObject({ isError: true, step: 'execution' });
    expect(JSON.parse(addRes.content).message).toContain('timed out after 50ms');
  });

  it('default policy: task timeout is 300s, everything else stays 10s', () => {
    expect(DEFAULT_POLICY.timeoutMs).toBe(10_000);
    expect(DEFAULT_POLICY.toolTimeouts?.task).toBe(300_000);
  });

  it('step 4+5: execution errors become isError messages, never thrown', async () => {
    const g = makeGateway();
    const r = await g.execute('add', { a: 1, b: 2 }, addSchema, async () => {
      throw new Error('boom');
    });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content)).toMatchObject({ isError: true, step: 'execution' });
  });

  it('step 5 postprocess: long results are truncated', async () => {
    const g = makeGateway();
    const r = await g.execute('add', { a: 1, b: 2 }, addSchema, async () => ({ content: 'x'.repeat(5000) }));
    expect(r.ok).toBe(true);
    expect(r.content.length).toBeLessThan(5000);
    expect(r.content).toContain('[truncated by gateway]');
  });

  it('repeat detection: same call 3 times blocks and opens the circuit breaker', async () => {
    const g = makeGateway();
    let calls = 0;
    const exec = async (args: any) => { calls += 1; return { content: `ok ${args.a}` }; };
    await g.execute('add', { a: 1, b: 2 }, addSchema, exec);
    await g.execute('add', { a: 1, b: 2 }, addSchema, exec);
    const third = await g.execute('add', { a: 1, b: 2 }, addSchema, exec);
    expect(third.ok).toBe(false);
    expect(JSON.parse(third.content)).toMatchObject({ isError: true, step: 'repeat_call' });
    expect(g.isCircuitOpen).toBe(true);
    expect(calls).toBe(2);
    // circuit open: further calls are refused without execution
    const fourth = await g.execute('add', { a: 5, b: 6 }, addSchema, exec);
    expect(JSON.parse(fourth.content)).toMatchObject({ step: 'circuit_breaker' });
    expect(calls).toBe(2);
  });

  it('step budget: calls beyond maxSteps are blocked', async () => {
    const g = makeGateway({ maxSteps: 2 });
    const exec = async (args: any) => ({ content: String(args.a) });
    await g.execute('add', { a: 1, b: 1 }, addSchema, exec);
    await g.execute('add', { a: 2, b: 1 }, addSchema, exec);
    const r = await g.execute('add', { a: 3, b: 1 }, addSchema, exec);
    expect(JSON.parse(r.content)).toMatchObject({ isError: true, step: 'step_budget' });
  });

  it('no-progress: 3 identical results stop with partial results', async () => {
    const g = makeGateway({ maxNoProgress: 3 });
    const exec = async () => ({ content: 'same-result' });
    await g.execute('check_health', { n: 1 }, undefined, exec);
    await g.execute('check_health', { n: 2 }, undefined, exec);
    const third = await g.execute('check_health', { n: 3 }, undefined, exec);
    expect(third.ok).toBe(true); // returns partial, not an error throw
    expect(JSON.parse(third.content)).toMatchObject({ isError: true, step: 'no_progress' });
  });
});
