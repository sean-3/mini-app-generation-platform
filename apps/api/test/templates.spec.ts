import { SIGNUP_SLOTS, TemplatesService } from '../src/templates/templates.service';

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

  it('signup: new fields validate (building + slot)', () => {
    const v = svc.validateData('signup', {
      signups: [{ id: 's1', name: '小明', count: 2, note: '', building: '3栋201', slot: '下午 16:00-18:00' }],
    });
    expect(v.valid).toBe(true);
  });

  it('signup: slot must be one of the options', () => {
    const v = svc.validateData('signup', {
      signups: [{ id: 's1', name: '小明', count: 2, building: '', slot: '半夜 00:00-01:00' }],
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/slot/);
  });

  it('signup: building must be text', () => {
    const v = svc.validateData('signup', {
      signups: [{ id: 's1', name: '小明', count: 2, building: 201 }],
    });
    expect(v.valid).toBe(false);
  });

  it('signup: old data without the new fields still validates (backward compatible)', () => {
    const v = svc.validateData('signup', {
      signups: [{ id: 's1', name: '小明', count: 2, note: '' }],
    });
    expect(v.valid).toBe(true);
  });

  it('signup: phone is optional and defaults to empty', () => {
    const v = svc.validateData('signup', {
      signups: [{ id: 's1', name: '小明', count: 2, note: '', building: '3栋201', slot: '下午 16:00-18:00', phone: '13800000001' }],
    });
    expect(v.valid).toBe(true);
    const old = svc.validateData('signup', {
      signups: [{ id: 's1', name: '小明', count: 2, note: '' }],
    });
    expect(old.valid).toBe(true);
  });

  it('signup: seed entries all carry building and a valid slot', () => {
    const data = svc.seedData('signup');
    expect(data.signups.length).toBe(6);
    expect(data.signups.reduce((s: number, p: any) => s + p.count, 0)).toBe(11);
    for (const p of data.signups) {
      expect(typeof p.building).toBe('string');
      expect(SIGNUP_SLOTS).toContain(p.slot);
      expect(typeof p.phone).toBe('string');
    }
  });
});
