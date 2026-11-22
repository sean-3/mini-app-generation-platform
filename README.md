# 迷你应用生成台 v4

ROOT / AI Native 全栈笔试。说一句话，一个 5 人 Agent 团队把它变成一个能用的小应用；应用是主角，全过程在侧栏时间线里可见，每一步工具调用都经过 Tool Gateway，两道审批由人确认。

## 先说清楚：模型是怎么回事

**这个版本调真实大模型：Kimi kimi-k3，Moonshot 国内站（api.moonshot.cn，OpenAI 兼容接口）。** 每次真实生成都烧真 token，时间和成本见下面和 Atoms 实测的对比。

- Agent 运行时是真实的：`deepagents` 1.17.0（JS 版）的 `createDeepAgent`，规划（`write_todos`）、`task` 子代理、中间件、工具循环都在跑。工具调用的顺序、次数、什么时候停，由模型自己决定；system prompt 只给角色、可用工具和最终输出的 JSON 契约。
- 模型层在 `apps/api/src/model-gateway/`：`createCloudModel()` 用 `@langchain/openai` 的 `ChatOpenAI`，`baseURL https://api.moonshot.cn/v1`，key 只从环境变量 `MOONSHOT_API_KEY` 读。
- **没有 key 就建不了 run**：`POST /api/runs` 直接返回 400，消息写明请设置 `MOONSHOT_API_KEY`。绝不用假模型冒充真模型跑流程。
- 确定性适配器（`deterministic-model.ts` + `deterministic-scripts.ts`）**只留给单测用**：`ModelGatewayService` 的第二个构造参数是测试工厂，生产装配（NestJS 模块）不传，`createModel()` 永远走云端模型。单测用它跑同一套阶段代码，证明流程本身没问题。
- 国际站和国内站是两套账号：`api.moonshot.ai` 的 key 在 `api.moonshot.cn` 上会 401，余额也不通用。本项目只用国内站。

## 和 Atoms 实测的成本 / 耗时对比

2026-11-23 在 Xiao 的 Atoms 账号上实测过一次真实生成（团购接龙报名页）：约 12 分钟，烧 14.41 个 credit（免费日额度 15 个，一天只够生成一次），59 步全是 Alex 一人干的，Team Mode 默认关，0 次审批。

本 Demo 的对照（本地实测数字见 SELFTEST.md v4 一节；真模型循环本地没 key，跑不了，数字来自确定性单测 + 部署后实测补）：

- 默认也是 Team Mode 关、单 Agent 自主做完；开 Team Mode 才走 5 人流程。
- 4 个模板，不是自由生成整站代码：一次生成 1–2 次模型调用（Team 开）或 1 次（简化 / Engineer），token 花费比 Atoms 自由生成低一个量级。
- 审批只在 Plan / 架构 / 发布三个点停下等用户点确认，不像 Atoms 那样每步都可能停。

## 产品按什么做的

只按两样东西：笔试说明的要求（6–8 小时可运行的 Atoms-Demo，真实交互 + 数据持久化，至少一个扩展能力，在线链接 + GitHub），和 atoms.dev 的功能（2026-11-23 逐页核对过官网与帮助中心原文，清单在 `../atoms-feature-checklist-2026-11-23.md`，71 个功能点，每条有来源；另有 2026-11-23 凌晨在 Xiao 的 Atoms 账号上的实测附录）。

按清单复刻下来的：

- 一句话输入框；Build / Plan 两种启动方式（Plan 是 Mike 先出计划、用户批准才开工）；Engineer 轻量模式（只派 Alex 一人干活）。
- Team Mode 可开关：关 = Mike + Alex 简化流程；开 = 完整 5 人团队可见（Mike 协调、Iris 调研、Emma 规格、Bob 架构、Alex 构建），并有 @ 点名入口。
- 两道真审批：架构确认、发布确认；Plan 模式多一道计划确认作为入口。拒绝回退。
- Preview 与上线分离：草稿先以 Preview 展示（未上线）；确认发布才上线 v1；发布后改数据只动工作区，点 Update 才更新线上版并把版本号 +1。
- 生成后能改：直接改数据、改文案（对话改没做——没有真实模型，解析不了自由文本，笔记里写清了）。
- 导出结果：导出 JSON（对应官网 Export 的等价物）；导出为文件被网关权限拦截（演示）。
- 评估回放：每次运行记完整 trace，回放页重放，分数按成功率、步数、耗时从真实 trace 算。评估是产品功能，不挂人名。回放页还显示本轮主 Agent 的 token 用量（输入 / 输出；Team Mode 开时子 Agent 的调用不在内，是下限）。

没做的（清单里写明了可砍 / 做不了）：Race Mode、Goal Mode、真实联网调研、支付、自定义域名、多用户、自由生成整站代码。只做 4 个模板，自由生成 6–8 小时做不出可靠的，模板是诚实的收窄。

## 架构（30 秒版）

```
前端 Vite + React（顶部输入 + 左侧应用主角 / 右侧时间线侧栏）
│ REST + SSE
后端 NestJS 12（单体 serve 前端静态，一个链接打开）
├─ agent/ Mike 协调者 + 5 人构建团队（Iris/Emma/Bob/Alex；Team 关时只剩 Mike + Alex；Engineer 时只剩 Alex）
│   每阶段一次 createDeepAgent 调用：plan / stageA（需求+架构）/ stageB（Alex 生成草稿）/ publish / review
│   模型输出先宽松解析 JSON（去 ``` 围栏），解析失败或缺字段就停下，不带空结果进审批
├─ tool-gateway/ Pi 五步：参数预处理 → Zod Schema 校验 → 权限拦截 → 执行 → 结果后处理
│ 失败编成 isError:true 消息，永不抛出；兜底：步数预算 25、重复 3 次熔断、无进展停下
├─ model-gateway/ 规则短路（模板意图本地匹配）→ Kimi kimi-k3 → 没有 key 直接报明确错误，不降级
│   token 用量累计进 runs.usage_json（主 Agent 各轮调用；子 Agent 不在内）
├─ templates/ 4 个模板：记账看板 / 习惯打卡 / 报价计算器 / 活动报名·接龙
├─ apps/ 应用 CRUD + 数据更新（Schema 校验）+ 导出（JSON 放行 / 写文件拦截）+ Update 发布新版
├─ persistence/ SQLite（node:sqlite，零原生编译），文件放 DATA_DIR，接口层已抽象，换 Postgres 只改这一处
├─ eval/ 回放评分：成功率 / 步数 / 耗时 / 工具调用数，用真实运行 trace 算
└─ health/ GET /health（返回模型名 + configured，配没配 key 一眼能看到）
```

流程（Team Mode 开）：Mike 出计划（仅 Plan 模式）→ Iris 调研 + Emma 需求 → Bob 架构（含设计说明）→ 架构审批 → Alex 生成草稿并自检 → 发布审批 → 发布上线 v1 → 冒烟 + 评估。一次生成 2 次模型调用（Team 开）或 1 次（简化 / Engineer）。拒绝任一道审批都会回退（计划拒绝 / 架构拒绝 → rolled_back；发布拒绝 → 草稿保留）。

两道审批用**自维护状态机**实现，不用 LangGraph `interrupt_on`：审批是阶段之间的 UI 门，不是工具调用门；状态机更简单、可测试，轨迹里照样留痕。

## 本地运行

```bash
npm install
npm run build # 先编 api + web
MOONSHOT_API_KEY=sk-... DATA_DIR=./data PORT=3000 npm start
# 打开 http://localhost:3000
```

没有 key 也能启动、看页面、跑 repeat-demo；但点“生成应用”会报 400（MOONSHOT_API_KEY 未设置），这是有意为之。

开发模式（两个终端）：

```bash
npm run dev:api # NestJS，http://localhost:3000
npm run dev:web # Vite，http://localhost:5173（/api 与 /health 代理到:3000）
```

环境变量（见 `.env.example`，真实 `.env` 不进仓库）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 后端端口 |
| `DATA_DIR` | `./data` | SQLite 文件目录（容器里是 `/app/data`，挂 volume，否则重启丢数据） |
| `MOONSHOT_API_KEY` | （必填） | Moonshot 国内站 key（platform.moonshot.cn 上开的）；不设就建不了 run |
| `MOONSHOT_MODEL` | `kimi-k3` | 模型名；换模型只改这一处 |

## Docker 运行（单体部署）

```bash
MOONSHOT_API_KEY=sk-... docker compose up --build -d
# 打开 http://localhost:3000
docker compose logs -f api
docker compose down # 数据留在./data，下次 up 还在
```

镜像是多阶段构建（node:24-alpine）：先编 api + web，再只留生产依赖；带 `HEALTHCHECK`（`/health`）；数据目录 `/app/data` 由外部挂载的 volume 提供（不写 `VOLUME` 指令，Railway 会拒绝它）。前端由 NestJS 同源 serve，**一个链接就能打开**，不用分开部署。

分离部署（前端 Vercel + 后端容器）也行：前端 `npm run build --workspace=apps/web` 后部署 `apps/web/dist`，把 `apps/web/vite.config.ts` 里的 proxy 目标改成后端公网地址；后端照常 `docker compose up`。提交时优先给单体链接。

## 测试

```bash
npm test # 后端单测 + E2E，37 个
```

覆盖：Tool Gateway 五步（预处理/校验/权限/执行异常/截断、重复 3 次熔断、步数预算、无进展停下）、**网关中间件在真 DeepAgents 循环里拦截**（模型调 `export_file`，执行 0 次，模型看到 `isError:true`）、Model Gateway（无 key 报明确错误；有 key 返回 ChatOpenAI kimi-k3 + 国内站 baseURL；测试工厂只在单测走）、模板匹配与种子数据校验、评估算分、Agent 全流程 E2E（Build 简化流程两道审批发布 + Update v2、Plan 模式计划审批通过与拒绝回退、Team Mode 开 5 人流程且轨迹无多余角色名、Engineer 模式 Alex 一人且跳过 Stage B、架构拒绝回退、无匹配停下、**无 key 时 createRun 抛 MOONSHOT_API_KEY 错误且不建 run**、重复演示拦截）。

## 两个拦截演示（都在前端点一点就能看到）

1. **报价 → 导出为文件**：`export_file` 在 Tool Gateway「权限拦截」一步被拦，返回 `isError:true`（HTTP 200，不是 500），前端弹出拦截说明，并给「改用导出 JSON」。
2. **重新生成（连点 3 次）**：每次点击跑一次 repeat-demo，模型连续 3 次调 `match_template` 传同一参数，第 3 次被重复检测拦截并打开熔断，run 停下；按钮第 3 次点击后变成「重新生成（已停止）」并禁用。

## 自测结果

见 `SELFTEST.md`（逐项真实驱动记录，含 v4 一节）。**真模型循环本地没验证**：本机没有 `MOONSHOT_API_KEY`，E2E 测的是确定性模型走同一套阶段代码；部署后在 Railway 上配好 key 再验真循环。

## v3 到 v4 改了什么

- 编排核心从“写死流程 + 假模型”换成真 Agent 循环：每阶段一次 `createDeepAgent`，模型是 Kimi kimi-k3（Moonshot 国内站），工具调用顺序由模型决定；`write_todos` 规划用 DeepAgents 自带的 `todoListMiddleware`。
- `ModelGatewayService`：`createCloudModel()` 返回 ChatOpenAI（kimi-k3，`https://api.moonshot.cn/v1`）；无 key 时 `createRun` 直接 400，不跑流程；确定性适配器只留给单测（测试工厂参数，生产装配不传）。
- `runs` 表加 `usage_json`：主 Agent 各轮调用的 token 用量，回放页显示；Team Mode 开时子 Agent 不在内，是下限。
- `/health` 返回模型信息（provider / model / configured）；前端顶栏显示模型名和配没配 key。
- 测试 32 → 37：新增网关中间件拦截测试、云端模型测试、无 key 建 run 测试。
- 修了一个启动 bug：`ModelGatewayService` 的测试工厂参数没加 `@Optional()`，Nest 启动时报 `UnknownDependenciesException`（v4 自测时发现的，见 SELFTEST.md）。

## 评审意见的落地情况

- 必须改 1：至少接一个真实模型才算“智能体驱动”——**已做到**：Kimi kimi-k3，Moonshot 国内站；无 key 时明确报错，不用假模型冒充。本地没 key 验证不了真循环，SELFTEST 写清了，部署后验。
- 必须改 2：0.5h spike 验证 middleware 拦截——**通过**，5/5（见 v2 架构文件末尾 §十二）。拦截落在 `createMiddleware` 的 `wrapToolCall` 上；v4 又补了一个真循环里的拦截测试。
- 必须改 3：SQLite 不能跟容器走——**已改**：数据卷 `./data:/app/data`，`DATA_DIR` 可配；重启后数据还在（已实测）。
- 建议改 4：虚拟文件系统降级——**已做**：草稿存 SQLite JSON 字段，只留 FS 接口，不实现 FilesystemBackend。
- 建议改 5：四个串行角色合并——**已做**：Iris+Emma 一次调用，Bob 架构（含设计），一次生成 2 次模型调用（Team 开）或 1 次（简化 / Engineer）。

## 实现时的几个坑（写给接手的人）

1. **subagent 结果曾是空字符串**：`task` 工具返回的是 LangGraph `Command`（携带状态更新），不是 `ToolMessage`。网关中间件直接取 `.content` 会拿到空字符串。修复：`createToolGatewayMiddleware` 识别 Command，从 `update.messages` 里取 ToolMessage 内容做网关记账，`raw` 原样透传。
2. **subagents 必须传原始 spec**：`createSubAgent()` 编译后的 ReactAgent 没有 `.name`，`createDeepAgent` 按 `agentParams.name` 去重会报 `Duplicate subagent name 'undefined'`。直接传 spec 对象，让框架内部编译。
3. **子 Agent 的工具调用也要过网关**：网关中间件只挂在主 Agent 上时，subagent 内部的 `match_template` / `read_template` 不走网关、也不进轨迹。每个 subagent spec 都挂了同一个网关中间件实例（同一 run 共享预算与重复计数）。
4. **`task` 工具的 schema 只有两个字段**：`{ description, subagent_type }`，没有 `input`。子 Agent 收到的 HumanMessage 就是 `description` 的内容——派活时要把用户需求全文写进 `description`，别只写一句“去调研”，否则子 Agent 看不到原需求。
5. **Nest 注入可选的函数参数要加 `@Optional()`**：`ModelGatewayService` 的测试工厂是函数类型，生产装配不传；不加 `@Optional()`，Nest 启动就报 `UnknownDependenciesException`，服务起不来。
6. **持久化用 `node:sqlite`**（Node 24 内置 `DatabaseSync`），不是 better-sqlite3：零原生编译风险；访问层在 `DatabaseService`，换 Postgres 只改这一模块。
7. **数据库迁移用 ALTER TABLE + try/catch**：已部署的库没有 v3/v4 新增的列（`runs.mode/team_mode/plan_json/usage_json`、`apps.published_json/published_version`），启动时逐列加，列已存在就忽略；`CREATE TABLE IF NOT EXISTS` 不会给旧库加列。

## 部署还缺什么（部署账号在 Xiao 手里）

1. Railway 上给 `api` 服务加环境变量 **`MOONSHOT_API_KEY`**（Moonshot 国内站 platform.moonshot.cn 的 key），否则线上点生成会 400。`MOONSHOT_MODEL` 不设就是 `kimi-k3`；`DATA_DIR=/app/data` 已有，volume 已挂。
2. 一个公网容器托管（二选一）：Railway 或 Render——新建服务 → 连 GitHub 仓库 → 根目录 `docker compose up` 的等价部署（或直接用 Dockerfile）→ 设环境变量 `DATA_DIR=/app/data` 并挂一个 volume → 拿到公网域名。
3. 前端不用单独部署（单体 serve）。如果坚持分离，见上文“分离部署”。
4. 把公网链接 + GitHub 仓库链接填进飞书笔试文档 §4（复制原文档、标题加姓名、权限公开、无痕模式自查），再把文档链接发给 HR。
5. $70 Atoms 额度（如需）：短信注册邮箱到 13681411948，等 HR 处理——与本工程无关。

注意：Railway 服务的 Watch Paths 只监听 `apps/api/**`，根目录、Dockerfile、前端改动不会自动部署——推 main 后手动点一次部署。
