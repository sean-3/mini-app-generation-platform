import { Injectable } from '@nestjs/common';
import { DeterministicModel, type PlanStep } from './deterministic-model';
import { TemplatesService } from '../templates/templates.service';

/**
 * Model Gateway：模型路由。
 * 路由顺序（对应 Notion §3 端云协同的降级思想：够用就停）：
 * 1. 规则引擎短路：模板意图本地匹配，几毫秒，不调模型；
 * 2. 确定性编排：DeepAgents 循环 + 确定性模型跑完整流程；
 * 3. 云端 LLM 兜底：插槽（见 createCloudModel），需 LLM_PROVIDER + LLM_API_KEY。
 *
 * 诚实说明：当前环境没有 LLM key，生成决策由确定性模型 + 规则引擎承担，
 * 没有调用任何真实大模型。README 与实现笔记里同样写清。
 */
@Injectable()
export class ModelGatewayService {
  constructor(private readonly templates: TemplatesService) {}

  /** 规则引擎短路：本地意图分类（“端侧”象征：不调模型，先本地判）。 */
  routeLocal(input: string): { templateId: string | null; confidence: number } {
    const m = this.templates.match(input);
    return m ? { templateId: m.templateId, confidence: m.confidence } : { templateId: null, confidence: 0 };
  }

  createDeterministicModel(plan: PlanStep[]): DeterministicModel {
    return new DeterministicModel(plan);
  }

  /**
   * 云端 LLM 插槽。接入真实 key 时只改这里：
   * 安装对应 provider 包（如 @langchain/openai），按 provider 返回 ChatModel 实例。
   * 未配置时明确抛错，不静默降级、不假装调用。
   */
  createCloudModel(): never {
    throw new Error(
      'LLM provider is not configured. Set LLM_PROVIDER (e.g. openai) and LLM_API_KEY, ' +
        'install the provider package, and wire it in ModelGatewayService.createCloudModel(). ' +
        'Falling back to the deterministic model.',
    );
  }

  hasCloudModel(): boolean {
    return Boolean(process.env.LLM_PROVIDER && process.env.LLM_API_KEY);
  }
}
