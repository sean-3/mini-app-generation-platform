/**
 * 找到光标前最后一个 @ 后面的查询词（@ 指定 Agent 用）。
 * @ 后有空格/换行、或查询词超过 10 字 → 不是 @，返回 null。
 */
export function findMentionQuery(value: string, cursorPos: number): string | null {
  const before = value.slice(0, cursorPos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  // @ 前面不是开头也不是空白（比如邮箱 a@b.com）→ 不是 @。
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const q = before.slice(at + 1);
  if (/\s/.test(q) || q.length > 10) return null;
  return q;
}
