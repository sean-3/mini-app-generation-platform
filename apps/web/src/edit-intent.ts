import type { Template } from './api';

/** 改动词：出现在输入里，意思就是“改当前这个应用”。 */
const EDIT_VERBS = [
  '改成', '改为', '修改', '改一下', '调整', '换成', '删除', '删掉', '去掉', '更新',
  '加一条', '加一笔', '加一个报名', '加个报名', '追加', '改', '删',
];

/** 新做标记：出现在输入里，意思就是“新做一个”，哪怕带了“加”。 */
const NEW_MARKERS = ['我要', '新建', '新做', '生成一个', '做一个', '来一个', '创建一个'];

/**
 * 判断项目页聊天框的输入是“改当前应用”还是“新做一个”。
 * 只在已有应用时用：提到别的模板名 → 新做；带新做标记 → 新做；否则带改动词 → 改当前应用。
 * 规则短路，不调模型；拿不准的一律走新做（开新 run），不误改。
 */
export function isEditIntent(input: string, currentTemplateId: string | null, templates: Template[]): boolean {
  const t = input.trim();
  if (t.length < 2) return false;
  if (NEW_MARKERS.some((m) => t.includes(m))) return false;
  for (const tpl of templates) {
    if (tpl.id === currentTemplateId) continue;
    const short = tpl.name.replace(/[^一-鿿a-zA-Z]/g, '').slice(0, 2);
    if (t.includes(tpl.name) || (short.length === 2 && t.includes(short))) return false;
  }
  return EDIT_VERBS.some((v) => t.includes(v));
}
