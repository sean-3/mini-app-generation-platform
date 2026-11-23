import { isEditIntent } from '../../web/src/edit-intent';
import { diffSummary } from '../../web/src/diff';
import { findMentionQuery } from '../../web/src/mention';
import type { Template } from '../../web/src/api';

const TEMPLATES: Template[] = [
  { id: 'ledger', name: '记账看板', description: '', fields: [], cap: undefined },
  { id: 'habit', name: '习惯打卡', description: '', fields: [], cap: undefined },
  { id: 'quote', name: '报价计算器', description: '', fields: [], cap: undefined },
  { id: 'signup', name: '活动报名 / 接龙', description: '', fields: [], cap: 20 },
];

describe('isEditIntent (project-page chat input)', () => {
  it('“把接龙上限改成 30 人” on a signup app is an edit', () => {
    expect(isEditIntent('把接龙上限改成 30 人', 'signup', TEMPLATES)).toBe(true);
  });

  it('“加一条报名” is an edit', () => {
    expect(isEditIntent('加一条报名', 'signup', TEMPLATES)).toBe(true);
  });

  it('“加一笔 100 元餐饮” on a ledger app is an edit', () => {
    expect(isEditIntent('加一笔 100 元餐饮', 'ledger', TEMPLATES)).toBe(true);
  });

  it('“删最后一条报名” is an edit', () => {
    expect(isEditIntent('删最后一条报名', 'signup', TEMPLATES)).toBe(true);
  });

  it('“我要一个记账看板” while viewing signup is a new run, not an edit', () => {
    expect(isEditIntent('我要一个记账看板', 'signup', TEMPLATES)).toBe(false);
  });

  it('“加一个记账看板” while viewing signup mentions another template: new run', () => {
    expect(isEditIntent('加一个记账看板', 'signup', TEMPLATES)).toBe(false);
  });

  it('plain “小区团购接龙” without an edit verb is not an edit', () => {
    expect(isEditIntent('小区团购接龙', 'signup', TEMPLATES)).toBe(false);
  });

  it('empty / one-char input is not an edit', () => {
    expect(isEditIntent('', 'signup', TEMPLATES)).toBe(false);
    expect(isEditIntent('改', 'signup', TEMPLATES)).toBe(false);
  });
});

describe('diffSummary (published snapshot vs workspace data)', () => {
  const pub = JSON.stringify({ signups: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }, { id: 's5' }, { id: 's6' }] });

  it('array grew: 6 -> 7', () => {
    const cur = JSON.stringify({ signups: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }, { id: 's5' }, { id: 's6' }, { id: 's7' }] });
    expect(diffSummary(pub, cur)).toEqual([{ key: 'signups', kind: 'changed', summary: 'signups：6 条 → 7 条' }]);
  });

  it('no published snapshot: empty (new app, nothing to compare)', () => {
    expect(diffSummary(null, pub)).toEqual([]);
  });

  it('identical data: empty', () => {
    expect(diffSummary(pub, pub)).toEqual([]);
  });

  it('same length, content changed', () => {
    const cur = JSON.stringify({ signups: [{ id: 's1', name: '小明' }, { id: 's2' }, { id: 's3' }, { id: 's4' }, { id: 's5' }, { id: 's6' }] });
    const out = diffSummary(JSON.stringify({ signups: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }, { id: 's5' }, { id: 's6' }] }), cur);
    expect(out).toEqual([{ key: 'signups', kind: 'changed', summary: 'signups：6 条（内容有改动）' }]);
  });

  it('added and removed keys', () => {
    const out = diffSummary(JSON.stringify({ a: 1, b: 2 }), JSON.stringify({ a: 1, c: 3 }));
    expect(out).toEqual([
      { key: 'c', kind: 'added', summary: 'c：新增（3）' },
      { key: 'b', kind: 'removed', summary: 'b：已删除' },
    ]);
  });

  it('broken JSON on either side: empty, never throws', () => {
    expect(diffSummary('{broken', pub)).toEqual([]);
    expect(diffSummary(pub, '{broken')).toEqual([]);
  });
});

describe('findMentionQuery (@ mention in project-page chat input)', () => {
  it('bare @ at the end opens the list with an empty query', () => {
    expect(findMentionQuery('团购接龙 @', 7)).toBe('');
  });

  it('partial name after @ is the query', () => {
    expect(findMentionQuery('让 @Bo 看看', 5)).toBe('Bo');
  });

  it('no @ before the cursor: null', () => {
    expect(findMentionQuery('团购接龙', 4)).toBeNull();
  });

  it('@ followed by a space is not a mention', () => {
    expect(findMentionQuery('邮箱 a@b.com', 10)).toBeNull();
  });

  it('@ in earlier text but cursor is after a space: null', () => {
    expect(findMentionQuery('@Bob 改一下', 9)).toBeNull();
  });

  it('only the last @ counts', () => {
    expect(findMentionQuery('@Bob 和 @Al', 10)).toBe('Al');
  });
});
