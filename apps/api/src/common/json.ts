/**
 * 宽松解析一段文本里的 JSON：去 ``` 围栏 → 直接解析 → 取首尾大括号子串。
 * 模型常把 JSON 包在围栏里，直接 JSON.parse 会失败。
 * 解析失败返回 null，调用方按“失败”处理，不带 null 继续走。
 */
export function parseJsonLoose(text: string): any | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
