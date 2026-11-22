import { Injectable, Optional } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DeterministicModel, type PlanStep } from './deterministic-model';
import { TemplatesService } from '../templates/templates.service';
// 副作用 import：第一次 createDeepAgent 之前注册 Kimi 的 harness profile，
// 把 ls / glob / grep 等文件系统工具从 Agent 的工具列表里拿掉（见 harness-profile.ts）。
import './harness-profile';

/**
 * Model Gateway：模型路由。
 * 路由顺序（对应 Notion §3 端云协同的降级思想：够用就停）：
 * 1. 规则引擎短路：模板意图本地匹配，几毫秒，不调模型；
 * 2. 真实模型：Kimi kimi-k3（Moonshot 国内站，OpenAI 兼容接口），Agent 循环由它驱动；
 * 3. 降级：没有 key 不跑流程，直接报明确错误——绝不用假模型冒充真模型。
 *
 * 确定性模型只留给单测（AgentService 的 deterministic 测试开关）。
 * 生产路径（NestJS 模块装配）永远走 createCloudModel()。
 */
@Injectable()
export class ModelGatewayService {
  constructor(
    private readonly templates: TemplatesService,
    /**
     * 只给单测用：返回每个阶段用的确定性模型。
     * 生产装配不传这个参数，createModel() 永远走云端模型。
     * @Optional：Nest 容器里没有这个函数的 provider，不传就注 undefined。
     */
    @Optional() private readonly testModelFactory?: (phase: string, ctx: Record<string, unknown>) => BaseChatModel,
  ) {}

  /** 规则引擎短路：本地意图分类（“端侧”象征：不调模型，先本地判）。 */
  routeLocal(input: string): { templateId: string | null; confidence: number } {
    const m = this.templates.match(input);
    return m ? { templateId: m.templateId, confidence: m.confidence } : { templateId: null, confidence: 0 };
  }

  /** 单测用的确定性模型：按剧本返回工具调用决策，不是大模型。 */
  createDeterministicModel(plan: PlanStep[]): DeterministicModel {
    return new DeterministicModel(plan);
  }

  /** Agent 各阶段用的模型：单测走确定性模型，生产走 Kimi kimi-k3。 */
  createModel(phase: string, ctx: Record<string, unknown>): BaseChatModel {
    if (this.testModelFactory) return this.testModelFactory(phase, ctx);
    return this.createCloudModel();
  }

  /** 云端模型：Kimi kimi-k3，Moonshot 国内站。key 只从环境变量读。 */
  createCloudModel(): ChatOpenAI {
    const apiKey = process.env.MOONSHOT_API_KEY;
    if (!apiKey) {
      throw new Error(
        'MOONSHOT_API_KEY 未设置：请设置环境变量 MOONSHOT_API_KEY（Moonshot 国内站 platform.moonshot.cn 的 key），' +
          '否则无法创建 run。国际站（api.moonshot.ai）和国内站（api.moonshot.cn）账号、余额、key 各算各的，key 不能混用。',
      );
    }
    return new ChatOpenAI({
      model: process.env.MOONSHOT_MODEL ?? 'kimi-k3',
      apiKey,
      configuration: { baseURL: 'https://api.moonshot.cn/v1' },
    });
  }

  hasCloudModel(): boolean {
    return Boolean(process.env.MOONSHOT_API_KEY);
  }

  /** 是否接了单测用的确定性模型工厂（生产装配永远是 false）。 */
  isTestMode(): boolean {
    return Boolean(this.testModelFactory);
  }

  /** 当前配置的模型名（默认 kimi-k3），给 /health 和前端展示用。 */
  modelName(): string {
    return process.env.MOONSHOT_MODEL ?? 'kimi-k3';
  }
}
