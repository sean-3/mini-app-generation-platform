import { Injectable } from '@nestjs/common';
import { z } from 'zod';

export type TemplateId = 'ledger' | 'habit' | 'quote' | 'signup';

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
      description: '填姓名、人数、备注报名，满员自动提示。',
      keywords: ['报名', '接龙', '团购', '活动', '拼团', '组织'],
      fields: [
        { key: 'name', label: '姓名', type: 'text' },
        { key: 'count', label: '人数', type: 'number' },
        { key: 'note', label: '备注', type: 'text' },
      ],
      schema: signupSchema,
      cap: 20,
      seed: () => ({
        signups: [
          { id: 's1', name: '小明', count: 2, note: '' },
          { id: 's2', name: '阿华', count: 1, note: '不要辣' },
          { id: 's3', name: '小红', count: 3, note: '' },
          { id: 's4', name: '大刘', count: 2, note: '' },
          { id: 's5', name: '小美', count: 1, note: '' },
          { id: 's6', name: '老陈', count: 2, note: '自提' },
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

  validateData(id: TemplateId, data: unknown): { valid: boolean; errors: string[] } {
    const t = this.get(id);
    if (!t) return { valid: false, errors: [`unknown template ${id}`] };
    const parsed = t.schema.safeParse(data);
    if (parsed.success) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`),
    };
  }
}
