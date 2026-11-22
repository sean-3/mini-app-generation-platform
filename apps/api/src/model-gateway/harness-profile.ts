import { getHarnessProfile, registerHarnessProfile } from 'deepagents';

/**
 * DeepAgents 1.17.0 的 createDeepAgent 会给主 Agent 和每个子 Agent 都挂
 * FilesystemMiddleware，默认带 ls / read_file / write_file / edit_file /
 * delete / glob / grep / execute 八个文件系统工具。我们的 Agent 没有文件
 * 系统：应用是 SQLite 里的结构化 JSON，不是磁盘文件。真模型不知道这点，
 * 线上实测（run df4df137）里它去调 ls / glob / grep 找文件，被网关拦下
 * 后换别的工具继续试，save_draft 重复调了 4 次，run 卡在 generating。
 *
 * 修法：按模型注册 harness profile，把文件系统工具从 Agent 的工具列表里
 * 拿掉，模型根本看不到它们，就不会去试。注册分两层：
 * - provider 层 "openai"：真正生效的一层。deepagents 按 getModelProvider
 *   把 ChatOpenAI 认作 openai；但 getModelIdentifier 只读 model_name /
 *   modelName，当前 @langchain/openai 的 ChatOpenAI 这两个字段都是
 *   undefined（模型名只在 `model` 字段里），所以 "openai:kimi-k3" 这种
 *   按模型名的 key 永远查不到，profile 解析会退到只按 provider 查。
 *   本服务只用 Kimi 模型，provider 层收敛就是 Kimi 收敛。
 * - 按模型名的 key 也注册（kimi-k3 等五个实测可用的 id）：如果以后
 *   langchain 恢复了 modelName，逐模型 key 照样生效；现在是备用。
 * MOONSHOT_MODEL 换成这五个 id 之外的名字时，两层都查不到，文件系统
 * 工具会回来，但系统提示和网关注册表两道防线还在。
 *
 * 两个框架限制，写清楚：
 * - FilesystemMiddleware 是必需中间件，排不掉；read_file 是它强制保留的，
 *   computeProfileFilesystemTools 在排除列表为空时也会补回 read_file，
 *   所以 read_file 仍在工具列表里——它不在网关白名单里，调了会被拦下，
 *   系统提示里也写明禁掉。
 * - 注册是全局的（globalThis 里的表），set 字段求并集，重复注册无害；
 *   必须在第一次 createDeepAgent 之前执行，所以本模块在
 *   ModelGatewayService 加载时就 import（副作用 import）。
 */
export const KIMI_MODEL_IDS = [
  'kimi-k3',
  'kimi-k3.1-pro',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.6',
] as const;

/** 从工具列表里拿掉的文件系统工具（read_file 框架强制保留，去不掉）。 */
export const EXCLUDED_FILESYSTEM_TOOLS = [
  'ls',
  'write_file',
  'edit_file',
  'delete',
  'glob',
  'grep',
  'execute',
] as const;

export function registerKimiHarnessProfiles(): void {
  // provider 层是真正生效的一层（见文件头注释：按模型名的 key 当前查不到）。
  registerHarnessProfile('openai', { excludedTools: [...EXCLUDED_FILESYSTEM_TOOLS] });
  for (const modelId of KIMI_MODEL_IDS) {
    registerHarnessProfile(`openai:${modelId}`, {
      excludedTools: [...EXCLUDED_FILESYSTEM_TOOLS],
    });
  }
}

registerKimiHarnessProfiles();

/** 单测用：查某个 Kimi 模型当前注册的 profile（排除列表是否生效）。 */
export function kimiHarnessProfile(modelId: string) {
  return getHarnessProfile(`openai:${modelId}`);
}
