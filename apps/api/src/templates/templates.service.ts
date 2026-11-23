import { Injectable } from '@nestjs/common';
import { z } from 'zod';

export type TemplateId = 'ledger' | 'habit' | 'quote' | 'signup';

/** 接龙自取时间段选项。改这里要同步改 apps/web/src/preview.tsx 里的 SLOTS。 */
export const SIGNUP_SLOTS = ['上午 09:00-11:00', '下午 16:00-18:00', '晚上 18:00-20:00'] as const;

export interface AppTemplate {
  id: TemplateId;
  name: string;
  description: string;
  keywords: string[];
  fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'date' | 'select' }>;
  /** Zod schema for the template's data payload */
  schema: z.ZodType<any>;
  seed: () => any;
  cap?: number;
}

const ledgerSchema = z.object({
  records: z.array(
    z.object({
      id: z.string(),
      amount: z.number(),
      category: z.string(),
      date: z.string(),
      note: z.string().optional().default(''),
    }),
  ),
});

const habitSchema = z.object({
  habits: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      streak: z.number().int().nonnegative(),
      week: z.array(z.boolean()).length(7),
    }),
  ),
});

const quoteSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      item: z.string(),
      qty: z.number().positive(),
      price: z.number().nonnegative(),
    }),
  ),
});

const signupSchema = z.object({
  signups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      count: z.number().int().positive(),
      note: z.string().optional().default(''),
      // 向后兼容：老数据没有这两个字段也能通过校验，缺失时给默认值
      // （楼栋房号默认空、自取时间段默认第一项）；新数据必须符合校验。
      building: z.string().optional().default(''),
      slot: z.enum(SIGNUP_SLOTS).optional().default(SIGNUP_SLOTS[0]),
      // 手机号：可选，展示时脱敏（前三后四，中间 ****）；老数据缺失默认空。
      phone: z.string().optional().default(''),
      // 购买内容：模型生成团购报名时常用（例：草莓1盒 + 土鸡蛋30枚）；预览单独一列，老数据缺失默认空。
      items: z.string().optional().default(''),
    }),
  ),
});

const today = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class TemplatesService {
  private readonly templates: AppTemplate[] = [
    {
      id: 'ledger',
      name: '记账看板',
      description: '记一笔开支，按分类汇总，看当月合计。',
      keywords: ['记账', '花钱', '开支', '账本', '记一笔', '收支', '花销'],
      fields: [
        { key: 'amount', label: '金额', type: 'number' },
        { key: 'category', label: '分类', type: 'select' },
        { key: 'date', label: '日期', type: 'date' },
        { key: 'note', label: '备注', type: 'text' },
      ],
      schema: ledgerSchema,
      seed: () => ({
        records: [
          { id: 'r1', amount: 42, category: '餐饮', date: today(), note: '午饭' },
          { id: 'r2', amount: 18.5, category: '交通', date: today(), note: '地铁' },
          { id: 'r3', amount: 128, category: '购物', date: today(), note: '日用品' },
          { id: 'r4', amount: 65, category: '餐饮', date: today(), note: '晚饭' },
          { id: 'r5', amount: 240, category: '娱乐', date: today(), note: '电影' },
          { id: 'r6', amount: 35, category: '餐饮', date: today(), note: '早餐' },
          { id: 'r7', amount: 96, category: '购物', date: today(), note: '水果' },
          { id: 'r8', amount: 74, category: '交通', date: today(), note: '打车' },
        ],
      }),
    },
    {
      id: 'habit',
      name: '习惯打卡',
      description: '建一个习惯，每天打卡，看连续天数和本周打卡格。',
      keywords: ['打卡', '习惯', '跑步', '读书', '自律', '坚持'],
      fields: [
        { key: 'name', label: '习惯名', type: 'text' },
        { key: 'streak', label: '连续天数', type: 'number' },
      ],
      schema: habitSchema,
      seed: () => ({
        habits: [
          { id: 'h1', name: '跑步', streak: 7, week: [true, true, true, true, true, true, true] },
          { id: 'h2', name: '读书', streak: 7, week: [true, true, true, true, true, false, true] },
        ],
      }),
    },
    {
      id: 'quote',
      name: '报价计算器',
      description: '加行算价，自动算小计和总价，可改可删。',
      keywords: ['报价', '计算器', '价格', '报价单', '预算', '算价'],
      fields: [
        { key: 'item', label: '项目', type: 'text' },
        { key: 'qty', label: '数量', type: 'number' },
        { key: 'price', label: '单价', type: 'number' },
      ],
      schema: quoteSchema,
      seed: () => ({
        rows: [
          { id: 'q1', item: '设计费', qty: 1, price: 2000 },
          { id: 'q2', item: '开发工时', qty: 10, price: 800 },
          { id: 'q3', item: '服务器（年）', qty: 1, price: 1200 },
          { id: 'q4', item: '域名（年）', qty: 1, price: 69 },
        ],
      }),
    },
    {
      id: 'signup',
      name: '活动报名 / 接龙',
      description: '填姓名、楼栋房号、手机号、人数、购买内容、自取时间段、备注报名，满员自动提示，组织者看报名统计。',
      keywords: ['报名', '接龙', '团购', '活动', '拼团', '组织'],
      fields: [
        { key: 'name', label: '姓名', type: 'text' },
        { key: 'building', label: '楼栋房号', type: 'text' },
        { key: 'phone', label: '手机号', type: 'text' },
        { key: 'count', label: '人数', type: 'number' },
        { key: 'items', label: '购买内容', type: 'text' },
        { key: 'slot', label: '自取时间段', type: 'select' },
        { key: 'note', label: '备注', type: 'text' },
      ],
      schema: signupSchema,
      cap: 20,
      seed: () => ({
        // 演示数据：6 条报名共 11 份，时间段三档都有，楼栋房号为示例值，手机号为演示号（展示时脱敏）。
        signups: [
          { id: 's1', name: '小明', count: 2, note: '', building: '3栋201', slot: '下午 16:00-18:00', phone: '13800000001' },
          { id: 's2', name: '阿华', count: 1, note: '不要辣', building: '1栋1203', slot: '晚上 18:00-20:00', phone: '13800000002' },
          { id: 's3', name: '小红', count: 3, note: '', building: '5栋802', slot: '下午 16:00-18:00', phone: '13800000003' },
          { id: 's4', name: '大刘', count: 2, note: '', building: '2栋305', slot: '晚上 18:00-20:00', phone: '13800000004' },
          { id: 's5', name: '小美', count: 1, note: '', building: '3栋1501', slot: '上午 09:00-11:00', phone: '13800000005' },
          { id: 's6', name: '老陈', count: 2, note: '自提', building: '1栋608', slot: '下午 16:00-18:00', phone: '13800000006' },
        ],
      }),
    },
  ];

  list(): Array<Pick<AppTemplate, 'id' | 'name' | 'description' | 'fields' | 'cap'>> {
    return this.templates.map(({ id, name, description, fields, cap }) => ({
      id,
      name,
      description,
      fields,
      cap,
    }));
  }

  get(id: string): AppTemplate | undefined {
    return this.templates.find((t) => t.id === id);
  }

  /** 规则引擎短路：关键词命中计分，最高分胜出；无命中返回 null。 */
  match(input: string): { templateId: TemplateId; confidence: number; reason: string } | null {
    let best: { templateId: TemplateId; confidence: number; reason: string } | null = null;
    for (const t of this.templates) {
      const hits = t.keywords.filter((k) => input.includes(k));
      if (hits.length === 0) continue;
      const confidence = Math.min(0.5 + hits.length * 0.2, 0.95);
      if (!best || confidence > best.confidence) {
        best = { templateId: t.id, confidence, reason: `命中关键词：${hits.join('、')}` };
      }
    }
    return best;
  }

  seedData(id: TemplateId): any {
    const t = this.get(id);
    if (!t) throw new Error(`unknown template ${id}`);
    return t.seed();
  }

  /**
   * 解析并归一化数据：成功时返回应用了默认值、去掉未知字段后的数据。
   * save_draft 和 updateData 都存解析后的结果，不存原始输入——否则模型自造的
   * 字段（如 items）和缺失的可选字段（如 slot）会原样进库，预览按模板字段
   * 渲染时对不上（线上 run 6cae5a4e：报名带 items 无 slot，备注列空白、时间段列全是默认上午）。
   */
  parseData(id: TemplateId, data: unknown): { ok: boolean; data?: any; errors: string[] } {
    const t = this.get(id);
    if (!t) return { ok: false, errors: [`unknown template ${id}`] };
    const parsed = t.schema.safeParse(data);
    if (parsed.success) return { ok: true, data: parsed.data, errors: [] };
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`),
    };
  }

  validateData(id: TemplateId, data: unknown): { valid: boolean; errors: string[] } {
    const r = this.parseData(id, data);
    return { valid: r.ok, errors: r.errors };
  }
}
