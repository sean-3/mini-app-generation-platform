import { summarizeChanges } from '../src/apps/diff';

describe('summarizeChanges (top-level diff summary)', () => {
  it('array length change', () => {
    const out = summarizeChanges({ signups: [1, 2, 3, 4, 5, 6] }, { signups: [1, 2, 3, 4, 5, 6, 7] });
    expect(out).toEqual([{ key: 'signups', kind: 'changed', summary: 'signups：6 条 → 7 条' }]);
  });

  it('array same length but content changed', () => {
    const out = summarizeChanges({ signups: [{ name: 'a' }] }, { signups: [{ name: 'b' }] });
    expect(out).toEqual([{ key: 'signups', kind: 'changed', summary: 'signups：1 条（内容有改动）' }]);
  });

  it('scalar change is truncated to one line', () => {
    const long = '新标题' + '很长'.repeat(12);
    const out = summarizeChanges({ title: '旧标题' }, { title: long });
    expect(out[0].key).toBe('title');
    expect(out[0].kind).toBe('changed');
    expect(out[0].summary).toBe(`title：旧标题 → ${long.slice(0, 24)}…`);
  });

  it('added and removed top-level keys', () => {
    const out = summarizeChanges({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(out).toEqual([
      { key: 'c', kind: 'added', summary: 'c：新增（3）' },
      { key: 'b', kind: 'removed', summary: 'b：已删除' },
    ]);
  });

  it('no change returns empty list', () => {
    expect(summarizeChanges({ a: [1] }, { a: [1] })).toEqual([]);
  });

  it('non-object input is treated as empty', () => {
    expect(summarizeChanges(null, { a: 1 })).toEqual([{ key: 'a', kind: 'added', summary: 'a：新增（1）' }]);
  });
});
