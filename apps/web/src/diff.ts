/**
 * 顶层 diff 摘要（纯函数）：对比线上快照 published_json 和工作区 data_json，
 * 只报顶层键的变化。数组按长度对比，不展开逐行；标量值截断到一行；不比较嵌套。
 * 后端有一份同规则的实现（apps/api/src/apps/diff.ts），edit 接口用它列“改了哪几项”；
 * 这里用在审批卡和发布面板的“本次改动”里。不为了 diff 加后端接口。
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

function parse(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    return p !== null && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/** 对比线上快照和工作区数据。未发布过（published_json 为空）、任一侧解析失败、无变化时返回 []。 */
export function diffSummary(publishedJson: string | null, currentJson: string | null): TopLevelChange[] {
  const b = parse(publishedJson);
  if (!b) return [];
  const a = parse(currentJson);
  if (!a) return [];
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
