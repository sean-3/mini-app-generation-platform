import { TemplatesService } from '../src/templates/templates.service';

describe('TemplatesService', () => {
  const svc = new TemplatesService();

  it.each([
    ['我要记账', 'ledger'],
    ['帮我记一笔花销', 'ledger'],
    ['每天跑步打卡', 'habit'],
    ['做个报价计算器', 'quote'],
    ['小区团购接龙', 'signup'],
    ['组织活动报名', 'signup'],
  ])('match(%s) -> %s', (input, expected) => {
    expect(svc.match(input)?.templateId).toBe(expected);
  });

  it('no keyword match returns null', () => {
    expect(svc.match('在线商城')).toBeNull();
  });

  it('seed data validates against its own schema', () => {
    for (const t of svc.list()) {
      const data = svc.seedData(t.id);
      expect(svc.validateData(t.id, data).valid).toBe(true);
    }
  });

  it('validateData catches bad data', () => {
    const v = svc.validateData('ledger', { records: [{ id: 'x', amount: 'oops', category: '餐饮', date: '2026-11-22' }] });
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('signup template has a cap', () => {
    expect(svc.get('signup')?.cap).toBe(20);
  });
});
