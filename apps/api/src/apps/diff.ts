/**
 * 顶层 diff 摘要（纯函数）：对比两个 data_json 对象，只报顶层键的变化。
 * 数组按长度对比，不展开逐行；标量值截断到一行；不比较嵌套。
 * 后端 edit 接口用它列“改了哪几项”；前端有一份同规则的实现（apps/web/src/diff.ts），
 * 用在审批卡和发布面板的“本次改动”里。
 */
export type ChangeKind = 'added' | 'removed' | 'changed';

export interface TopLevelChange {
  key: string;
  kind: ChangeKind;
  summary: string;
}

function oneLine(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

function valueSummary(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} 条`;
  if (v !== null && typeof v === 'object') return '对象';
  return oneLine(v);
}

export function summarizeChanges(before: unknown, after: unknown): TopLevelChange[] {
  const b = (before !== null && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after !== null && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  const out: TopLevelChange[] = [];
  for (const key of Object.keys(a)) {
    if (!(key in b)) {
      out.push({ key, kind: 'added', summary: `${key}：新增（${valueSummary(a[key])}）` });
      continue;
    }
    const bv = b[key];
    const av = a[key];
    if (Array.isArray(bv) && Array.isArray(av)) {
      if (bv.length !== av.length) {
        out.push({ key, kind: 'changed', summary: `${key}：${bv.length} 条 → ${av.length} 条` });
      } else if (JSON.stringify(bv) !== JSON.stringify(av)) {
        out.push({ key, kind: 'changed', summary: `${key}：${av.length} 条（内容有改动）` });
      }
    } else if (JSON.stringify(bv) !== JSON.stringify(av)) {
      out.push({ key, kind: 'changed', summary: `${key}：${oneLine(bv)} → ${oneLine(av)}` });
    }
  }
  for (const key of Object.keys(b)) {
    if (!(key in a)) out.push({ key, kind: 'removed', summary: `${key}：已删除` });
  }
  return out;
}
