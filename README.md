# 迷你应用生成台 v2

ROOT / AI Native 全栈笔试重建。说一句话，9 个职能 Bot 组成的 Agent 团队把它变成一个能用的小应用；全过程可见，每一步工具调用都经过 Tool Gateway，两个审批点由人确认。

## 先说清楚：模型是怎么回事

**这个版本没有调用任何真实大模型。** 环境里没有 LLM API key，评审也要求诚实写清这一点。

- Agent 运行时是真实的：`deepagents` 1.17.0（JS 版）的 `createDeepAgent`，规划、subagents、中间件、工具循环都在跑。
- 模型层是一个确定性适配器（`apps/api/src/model-gateway/deterministic-model.ts`）：实现 LangChain `BaseChatModel` 接口，按剧本返回工具调用决策。Agent 的循环、网关拦截、审批、回放都是真的；只有“模型怎么想”这一步是写死的。
- 接入真实模型只改一处：`ModelGatewayService.createCloudModel()`（provider 插槽，见 `.env.example` 的 `LLM_PROVIDER` / `LLM_API_KEY`）。配好 key 后，把 `DeterministicModel` 换成云端模型即可，Agent 编排、网关、前端都不用动。
- 不要在任何提交材料里写“调用了大模型”——写“确定性编排 + 预留模型插槽”。

## 架构（30 秒版）

```
前端 Vite + React（三栏：流水线 / 输入+需求设计架构 / 实时预览）
│ REST + SSE
后端 NestJS 12（单体 serve 前端静态，一个链接打开）
├─ agent/ Mike 协调者 + 8 个职能 subagents（Iris/Emma/Nora/Bob/Alex/Tina/Oscar/David）
├─ tool-gateway/ Pi 五步：参数预处理 → Zod Schema 校验 → 权限拦截 → 执行 → 结果后处理
│ 失败编成 isError:true 消息，永不抛出；兜底：步数预算 25、重复 3 次熔断、无进展停下
├─ model-gateway/ 规则短路 → 确定性编排 → 云端 LLM 插槽（未配 key 时抛错，不静默降级）
├─ templates/ 4 个模板：记账看板 / 习惯打卡 / 报价计算器 / 活动报名·接龙
├─ apps/ 应用 CRUD + 数据更新（Schema 校验）+ 导出（JSON 放行 / 写文件拦截）
├─ persistence/ SQLite（node:sqlite，零原生编译），文件放 DATA_DIR，接口层已抽象，换 Postgres 只改这一处
├─ eval/ 回放评分：成功率 / 步数 / 耗时 / 工具调用数，用真实运行 trace 算
└─ health/ GET /health
```

9 个 Bot 的分工与闭环：Iris 调研 + Emma 需求（合并成一次调用）→ Nora 设计与 Bob 架构并行 →→ Alex 生成草稿 →→ Tina 冒烟 + Oscar 部署 → David 复盘打分 → 结论回流到需求。一次生成控制在 2 次模型调用内。拒绝任一道审批都会回退（架构拒绝 → rolled_back；发布拒绝 → 草稿保留）。

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

镜像是多阶段构建（node:24-alpine）：先编 api + web，再只留生产依赖；带 `HEALTHCHECK`（`/health`）；`VOLUME /app/data`。前端由 NestJS 同源 serve，**一个链接就能打开**，不用分开部署。

分离部署（前端 Vercel + 后端容器）也行：前端 `npm run build --workspace=apps/web` 后部署 `apps/web/dist`，把 `apps/web/vite.config.ts` 里的 proxy 目标改成后端公网地址；后端照常 `docker compose up`。提交时优先给单体链接。

## 测试

```bash
npm test # 后端单测 + E2E，27 个
```

覆盖：Tool Gateway 五步（预处理/校验/权限/执行异常/截断、重复 3 次熔断、步数预算、无进展停下）、Model Gateway 路由与云端插槽、模板匹配与种子数据校验、评估算分、Agent 全流程 E2E（两道审批通过发布、架构拒绝回退、无匹配停下、重复演示拦截）。

## 两个拦截演示（都在前端点一点就能看到）

1. **报价 → 导出为文件**：`export_file` 在 Tool Gateway「权限拦截」一步被拦，返回 `isError:true`（HTTP 200，不是 500），前端弹出拦截说明，并给「改用导出 JSON」。
2. **重新生成（连点 3 次）**：每次点击跑一次 repeat-demo，模型连续 3 次调 `match_template` 传同一参数，第 3 次被重复检测拦截并打开熔断，run 停下；按钮第 3 次点击后变成「重新生成（已停止）」并禁用。

## 自测结果

见 `SELFTEST.md`（逐项真实驱动记录）。

## 评审意见的落地情况

- 必须改 1：至少接一个真实模型才算“智能体驱动”——**未做到**（无 key）。诚实做法：确定性编排 + 插槽，README 与实现笔记写明。拿到 key 后只改 `createCloudModel` 一处。
- 必须改 2：0.5h spike 验证 middleware 拦截——**通过**，5/5（见架构文件末尾 §十二）。拦截落在 `createMiddleware` 的 `wrapToolCall` 上。
- 必须改 3：SQLite 不能跟容器走——**已改**：数据卷 `./data:/app/data`，`DATA_DIR` 可配；重启后数据还在（已实测）。
- 建议改 4：虚拟文件系统降级——**已做**：草稿存 SQLite JSON 字段，只留 FS 接口，不实现 FilesystemBackend。
- 建议改 5：四个串行角色合并——**已做**：Iris+Emma 一次调用，Nora/Bob 并行，一次生成 2 次模型调用。

## 实现时的两个坑（写给接手的人）

1. **subagent 结果曾是空字符串**：`task` 工具返回的是 LangGraph `Command`（携带状态更新），不是 `ToolMessage`。网关中间件直接取 `.content` 会拿到空字符串。修复：`createToolGatewayMiddleware` 识别 Command，从 `update.messages` 里取 ToolMessage 内容做网关记账，`raw` 原样透传。
2. **subagents 必须传原始 spec**：`createSubAgent()` 编译后的 ReactAgent 没有 `.name`，`createDeepAgent` 按 `agentParams.name` 去重会报 `Duplicate subagent name 'undefined'`。直接传 spec 对象，让框架内部编译。
3. **子 Agent 的工具调用也要过网关**：网关中间件只挂在主 Agent 上时，subagent 内部的 `match_template` / `read_template` 不走网关、也不进轨迹。每个 subagent spec 都挂了同一个网关中间件实例（同一 run 共享预算与重复计数）。
4. **持久化用 `node:sqlite`**（Node 24 内置 `DatabaseSync`），不是 better-sqlite3：零原生编译风险；访问层在 `DatabaseService`，换 Postgres 只改这一模块。

## 部署还缺什么（部署账号在 Xiao 手里）

1. 一个公网容器托管（二选一）：Railway 或 Render——新建服务 → 连 GitHub 仓库 → 根目录 `docker compose up` 的等价部署（或直接用 Dockerfile）→ 设环境变量 `DATA_DIR=/app/data` 并挂一个 volume → 拿到公网域名。
2. 前端不用单独部署（单体 serve）。如果坚持分离，见上文“分离部署”。
3. 把公网链接 + GitHub 仓库链接填进飞书笔试文档 §4（复制原文档、标题加姓名、权限公开、无痕模式自查），再把文档链接发给 HR。
4. $70 Atoms 额度（如需）：短信注册邮箱到 13681411948，等 HR 处理——与本工程无关。
