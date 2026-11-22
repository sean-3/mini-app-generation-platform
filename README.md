# 迷你应用生成台 v3

ROOT / AI Native 全栈笔试。说一句话，一个 5 人 Agent 团队把它变成一个能用的小应用；应用是主角，全过程在侧栏时间线里可见，每一步工具调用都经过 Tool Gateway，两道审批由人确认。

## 先说清楚：模型是怎么回事

**这个版本没有调用任何真实大模型。** 环境里没有 LLM API key，评审也要求诚实写清这一点。

- Agent 运行时是真实的：`deepagents` 1.17.0（JS 版）的 `createDeepAgent`，规划、subagents、中间件、工具循环都在跑。
- 模型层是一个确定性适配器（`apps/api/src/model-gateway/deterministic-model.ts`）：实现 LangChain `BaseChatModel` 接口，按剧本返回工具调用决策。Agent 的循环、网关拦截、审批、回放都是真的；只有“模型怎么想”这一步是写死的。
- 接入真实模型只改一处：`ModelGatewayService.createCloudModel()`（provider 插槽，见 `.env.example` 的 `LLM_PROVIDER` / `LLM_API_KEY`）。配好 key 后，把 `DeterministicModel` 换成云端模型即可，Agent 编排、网关、前端都不用动。
- 不要在任何提交材料里写“调用了大模型”——写“确定性编排 + 预留模型插槽”。

## 产品按什么做的

只按两样东西：笔试说明的要求（6–8 小时可运行的 Atoms-Demo，真实交互 + 数据持久化，至少一个扩展能力，在线链接 + GitHub），和 atoms.dev 的功能（2026-11-23 逐页核对过官网与帮助中心原文，清单在 `../atoms-feature-checklist-2026-11-23.md`，71 个功能点，每条有来源）。

按清单复刻下来的：

- 一句话输入框；Build / Plan 两种启动方式（Plan 是 Mike 先出计划、用户批准才开工）；Engineer 轻量模式（只派 Alex 一人干活）。
- Team Mode 可开关：关 = Mike + Alex 简化流程；开 = 完整 5 人团队可见（Mike 协调、Iris 调研、Emma 规格、Bob 架构、Alex 构建），并有 @ 点名入口。
- 两道真审批：架构确认、发布确认；Plan 模式多一道计划确认作为入口。拒绝回退。
- Preview 与上线分离：草稿先以 Preview 展示（未上线）；确认发布才上线 v1；发布后改数据只动工作区，点 Update 才更新线上版并把版本号 +1。
- 生成后能改：直接改数据、改文案（对话改没做——没有真实模型，解析不了自由文本，笔记里写清了）。
- 导出结果：导出 JSON（对应官网 Export 的等价物）；导出为文件被网关权限拦截（演示）。
- 评估回放：每次运行记完整 trace，回放页重放，分数按成功率、步数、耗时从真实 trace 算。评估是产品功能，不挂人名。

没做的（清单里写明了可砍 / 做不了）：Race Mode、Goal Mode、真实联网调研、支付、自定义域名、多用户、自由生成整站代码。只做 4 个模板，自由生成 6–8 小时做不出可靠的，模板是诚实的收窄。

## 架构（30 秒版）

```
前端 Vite + React（顶部输入 + 左侧应用主角 / 右侧时间线侧栏）
│ REST + SSE
后端 NestJS 12（单体 serve 前端静态，一个链接打开）
├─ agent/ Mike 协调者 + 5 人构建团队（Iris/Emma/Bob/Alex；Team 关时只剩 Mike + Alex；Engineer 时只剩 Alex）
├─ tool-gateway/ Pi 五步：参数预处理 → Zod Schema 校验 → 权限拦截 → 执行 → 结果后处理
│ 失败编成 isError:true 消息，永不抛出；兜底：步数预算 25、重复 3 次熔断、无进展停下
├─ model-gateway/ 规则短路 → 确定性编排 → 云端 LLM 插槽（未配 key 时抛错，不静默降级）
├─ templates/ 4 个模板：记账看板 / 习惯打卡 / 报价计算器 / 活动报名·接龙
├─ apps/ 应用 CRUD + 数据更新（Schema 校验）+ 导出（JSON 放行 / 写文件拦截）+ Update 发布新版
├─ persistence/ SQLite（node:sqlite，零原生编译），文件放 DATA_DIR，接口层已抽象，换 Postgres 只改这一处
├─ eval/ 回放评分：成功率 / 步数 / 耗时 / 工具调用数，用真实运行 trace 算
└─ health/ GET /health
```

流程（Team Mode 开）：Mike 出计划（仅 Plan 模式）→ Iris 调研 + Emma 需求 → Bob 架构（含设计说明）→ 架构审批 → Alex 生成草稿并自检 → 发布审批 → 发布上线 v1 → 冒烟 + 评估。一次生成控制在 2 次模型调用内（Team 开）或 1 次（简化 / Engineer）。拒绝任一道审批都会回退（计划拒绝 / 架构拒绝 → rolled_back；发布拒绝 → 草稿保留）。

两道审批用**自维护状态机**实现，不用 LangGraph `interrupt_on`：审批是阶段之间的 UI 门，不是工具调用门；状态机更简单、可测试，轨迹里照样留痕。

## 本地运行

```bash
npm install
npm run build # 先编 api + web
DATA_DIR=./data PORT=3000 npm start
# 打开 http://localhost:3000
```

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
| `LLM_PROVIDER` / `LLM_API_KEY` | 留空 | 云端模型插槽；留空 = 确定性编排 |

## Docker 运行（单体部署）

```bash
docker compose up --build -d
# 打开 http://localhost:3000
docker compose logs -f api
docker compose down # 数据留在./data，下次 up 还在
```

镜像是多阶段构建（node:24-alpine）：先编 api + web，再只留生产依赖；带 `HEALTHCHECK`（`/health`）；数据目录 `/app/data` 由外部挂载的 volume 提供（不写 `VOLUME` 指令，Railway 会拒绝它）。前端由 NestJS 同源 serve，**一个链接就能打开**，不用分开部署。

分离部署（前端 Vercel + 后端容器）也行：前端 `npm run build --workspace=apps/web` 后部署 `apps/web/dist`，把 `apps/web/vite.config.ts` 里的 proxy 目标改成后端公网地址；后端照常 `docker compose up`。提交时优先给单体链接。

## 测试

```bash
npm test # 后端单测 + E2E，32 个
```

覆盖：Tool Gateway 五步（预处理/校验/权限/执行异常/截断、重复 3 次熔断、步数预算、无进展停下）、Model Gateway 路由与云端插槽、模板匹配与种子数据校验、评估算分、Agent 全流程 E2E（Build 简化流程两道审批发布 + Update v2、Plan 模式计划审批通过与拒绝回退、Team Mode 开 5 人流程且轨迹无多余角色名、Engineer 模式 Alex 一人且跳过 Stage B、架构拒绝回退、无匹配停下、重复演示拦截）。

## 两个拦截演示（都在前端点一点就能看到）

1. **报价 → 导出为文件**：`export_file` 在 Tool Gateway「权限拦截」一步被拦，返回 `isError:true`（HTTP 200，不是 500），前端弹出拦截说明，并给「改用导出 JSON」。
2. **重新生成（连点 3 次）**：每次点击跑一次 repeat-demo，模型连续 3 次调 `match_template` 传同一参数，第 3 次被重复检测拦截并打开熔断，run 停下；按钮第 3 次点击后变成「重新生成（已停止）」并禁用。

## 自测结果

见 `SELFTEST.md`（逐项真实驱动记录，含 v3 一节）。

## v2 到 v3 改了什么

- 团队按 atoms.dev 来：删掉 Nora、Tina、Oscar、David 四个角色名。设计是 Bob 架构输出的一部分；冒烟和评估是产品功能，不挂人名。
- 主角换成生成的应用：顶部输入，下面左侧是应用（占大头），右侧是时间线侧栏。
- 加了 Build / Plan / Engineer 三种启动方式和 Team Mode 开关（@ 点名入口只在 Team Mode 开时出现）。
- Preview 与上线分离：`apps` 表加 `published_json`（线上快照）与 `published_version`（版本号）；发布 v1、改完点 Update 才更新线上版。
- 草稿先以 Preview 只读展示，发布后才能改数据。

## 评审意见的落地情况

- 必须改 1：至少接一个真实模型才算“智能体驱动”——**未做到**（无 key）。诚实做法：确定性编排 + 插槽，README 与实现笔记写明。拿到 key 后只改 `createCloudModel` 一处。
- 必须改 2：0.5h spike 验证 middleware 拦截——**通过**，5/5（见 v2 架构文件末尾 §十二）。拦截落在 `createMiddleware` 的 `wrapToolCall` 上。
- 必须改 3：SQLite 不能跟容器走——**已改**：数据卷 `./data:/app/data`，`DATA_DIR` 可配；重启后数据还在（已实测）。
- 建议改 4：虚拟文件系统降级——**已做**：草稿存 SQLite JSON 字段，只留 FS 接口，不实现 FilesystemBackend。
- 建议改 5：四个串行角色合并——**已做**：Iris+Emma 一次调用，Bob 架构（含设计），一次生成 2 次模型调用（Team 开）或 1 次（简化 / Engineer）。

## 实现时的两个坑（写给接手的人）

1. **subagent 结果曾是空字符串**：`task` 工具返回的是 LangGraph `Command`（携带状态更新），不是 `ToolMessage`。网关中间件直接取 `.content` 会拿到空字符串。修复：`createToolGatewayMiddleware` 识别 Command，从 `update.messages` 里取 ToolMessage 内容做网关记账，`raw` 原样透传。
2. **subagents 必须传原始 spec**：`createSubAgent()` 编译后的 ReactAgent 没有 `.name`，`createDeepAgent` 按 `agentParams.name` 去重会报 `Duplicate subagent name 'undefined'`。直接传 spec 对象，让框架内部编译。
3. **子 Agent 的工具调用也要过网关**：网关中间件只挂在主 Agent 上时，subagent 内部的 `match_template` / `read_template` 不走网关、也不进轨迹。每个 subagent spec 都挂了同一个网关中间件实例（同一 run 共享预算与重复计数）。
4. **持久化用 `node:sqlite`**（Node 24 内置 `DatabaseSync`），不是 better-sqlite3：零原生编译风险；访问层在 `DatabaseService`，换 Postgres 只改这一模块。
5. **数据库迁移用 ALTER TABLE + try/catch**：已部署的库没有 v3 新增的列（`runs.mode/team_mode/plan_json`、`apps.published_json/published_version`），启动时逐列加，列已存在就忽略；`CREATE TABLE IF NOT EXISTS` 不会给旧库加列。

## 部署还缺什么（部署账号在 Xiao 手里）

1. 一个公网容器托管（二选一）：Railway 或 Render——新建服务 → 连 GitHub 仓库 → 根目录 `docker compose up` 的等价部署（或直接用 Dockerfile）→ 设环境变量 `DATA_DIR=/app/data` 并挂一个 volume → 拿到公网域名。
2. 前端不用单独部署（单体 serve）。如果坚持分离，见上文“分离部署”。
3. 把公网链接 + GitHub 仓库链接填进飞书笔试文档 §4（复制原文档、标题加姓名、权限公开、无痕模式自查），再把文档链接发给 HR。
4. $70 Atoms 额度（如需）：短信注册邮箱到 13681411948，等 HR 处理——与本工程无关。

注意：Railway 服务的 Watch Paths 只监听 `apps/api/**`，根目录、Dockerfile、前端改动不会自动部署——推 main 后手动点一次部署。
