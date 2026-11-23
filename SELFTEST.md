# SELFTEST — v2 自测记录（2026-11-22，逐项真实驱动）

测试环境：Node 24 / npm 10；后端 `nest build` 产物 + `DATA_DIR=/tmp/v2data`；前端 `vite build` 产物由 NestJS 同源 serve。单测 27/27 通过（`npm test`，含 E2E）。

## Spike（架构 §十二，2026-11-22）

deepagents 1.17.0 `createMiddleware` + `wrapToolCall` 拦截：**通过 5/5**。
- 拦截可在执行前返回 `isError:true` ToolMessage，工具 0 次执行；
- 合法 `add(2,3)` 执行恰好 1 次，结果 5；
- `export_file` 权限拦截，0 次执行；
- 非法参数 `add("not-a-number",3)` Schema 拦截，0 次执行；
- 确定性模型驱动 `createDeepAgent` 完整循环（3 轮工具调用）不抛错。
结论：Tool Gateway 落在 middleware 上；包工具外层的兜底方案不需要。

## 自测逐项

| # | 项目 | 方法 | 结果 |
|---|---|---|---|
| 1 | 四模板主流程：接龙 | curl 建 run → 批架构 → 批发布 | ✅ published，app `b3acd7c3…`；eval 成功率 100%、13 步、11 次工具调用、0 错误、17 条 trace；种子 6 人 |
| 2 | 四模板主流程：记账 | 同上 | ✅ published；eval 100% / 13 步 / 11 调用；加 ¥42 后合计 ¥698.5 → ¥740.5 |
| 3 | 四模板主流程：打卡 | 同上 | ✅ published；eval 100% / 13 步 / 11 调用；跑步打卡切换一次，连续 7 → 6 天 |
| 4 | 四模板主流程：报价 | 同上 | ✅ published；eval 100% / 13 步 / 11 调用；加行后 4 → 5 行，总价 ¥11269 → ¥11469 |
| 5 | 刷新后数据还在 | 服务重启后 GET 同一 app | ✅ 4 个应用都在；接龙 7 人、记账/打卡/报价数据完整（SQLite 文件在 DATA_DIR） |
| 6 | 拦截演示 1：导出为文件 | POST `/api/apps/:id/export-file` | ✅ HTTP 200，`{"isError":true,"step":"permission","tool":"export_file","message":"export_file requires file-write permission; the current role is read-only. Use export_json instead."}` |
| 7 | 拦截演示 2：重新生成 | POST `/api/runs/repeat-demo` | ✅ run 状态 stopped；trace：第 1、2 次 `match_template` executed，第 3 次 `repeat_call` blocked（`Same tool call repeated 3 times…`），熔断打开 |
| 8 | 审批拒绝回退 | 建记账 run → 拒绝架构审批 | ✅ 状态 `rolled_back` |
| 9 | 无匹配输入 | 输入“在线商城” | ✅ 状态 stopped，带 guidance（未匹配到四个模板） |
| 10 | 回放评分 | GET `/api/runs/:id/replay` | ✅ 每轮 eval：成功率 100%、13 步、耗时 ~0.16s、11 工具调用；traces 17 条可查 |
| 11 | 单体部署：一个链接打开 | `node apps/api/dist/main.js` | ✅ `/health` 200；`/` 返回 Vite index.html；JS bundle `/assets/index-*.js` 200（247KB） |
| 12 | 我的应用列表 | GET `/api/apps` | ✅ 4 个应用；重命名/删除接口在控制器层存在（前端有入口） |
| 13 | 导出 JSON（放行） | POST `/api/apps/:id/export` | ✅ 返回完整 data_json（前端可下载文件） |
| 14 | 手机宽度无横向溢出 | 静态检查 | ⚠️ 未用真机/浏览器探针验证。已做：≤760px 单列布局、`minmax(0,1fr)`、表格内部横向滚动、表单子项 `min-width:0`、JSON 预块 `overflow:auto`。需主 agent 用浏览器在 360px 下实测确认。 |
| 15 | docker compose 干净状态 | — | ❌ **未跑**：本机无任何容器运行时（`docker`/`podman` 均未安装）。Dockerfile 与 compose 文件已静态核对：多阶段构建、拷贝路径与 `nest build`/`vite build` 产物一致、HEALTHCHECK 走 `/health`（alpine 自带 wget）、`./data:/app/data` 卷与 `DATA_DIR=/app/data` 对应。需在有 Docker 的机器上跑 `docker compose up --build` 验证。 |
| 16 | 前端浏览器实测 | — | ⚠️ 后端 API 全部用 curl 真实驱动；但前端页面只验证了静态资源可达（index.html + JS 200），**未在真实浏览器里点过一遍流程**。需主 agent 用浏览器探针走一遍：生成 → 两道审批 → 预览操作 → 两个拦截 → 回放。 |

## 已修的 bug（自测中发现）

1. **subagent 结果空字符串**：`task` 工具返回 LangGraph `Command`，网关中间件取 `.content` 得到 `""`，需求/设计/架构 JSON 全空。已修：识别 Command，从 `update.messages` 取内容，raw 透传；并给每个 subagent spec 挂网关中间件，子 Agent 的工具调用也进轨迹。
2. **无进展计数 off-by-one**：streak 从 0 起计，3 次相同结果要到第 4 次才触发。已修：首次出现即计 1，第 3 次相同结果触发。
3. **单测 `jest.fn` 在 ESM Jest 下未定义**：改为手动计数；另补 `makeGateway`（注册测试用 `add` 工具，不污染生产策略）。
4. **单测假 ToolMessage 无法被 LangChain 识别**：改用真实 `ToolMessage` 实例。
5. **`pkill -f` 误杀自己的 shell**：自测脚本问题，与工程无关；改用 `^node …main.js$` 精确匹配。

## 未完成项

- 真实 LLM 接入（无 key，见 README“先说清楚”一节）。
- docker compose 实机验证（本机无运行时）。
- 浏览器端点击级自测 + 360px 真机溢出验证（需主 agent 探针）。

## 主 agent 复核补记（2026-11-22 23:15）

- 独立复核：干净构建通过，单测 27/27 通过；真实 HTTP 驱动整条主流程（接龙发布成功，报名 6→7 人）；导出文件拦截 `isError:true`；重复演示第 3 次调用被 `repeat_call` 拦下、run 停下；重启后 7 条报名数据完整。
- 修掉一个真 bug：回放页评分一直显示 0。`EvalService.latest()` 把 score 写死成 0。已改成和 `compute()` 同一套公式（`scoreFor`），重建后复测回放评分 100 分，单测仍 27/27。
- 仍未验证：浏览器点击级实测、360px 真机溢出、docker compose 实机运行（本机无容器运行时）。

---

# SELFTEST — v3 自测记录（2026-11-23，逐项真实驱动）

测试环境：Node 24 / npm 10；后端 `nest build` 产物 + `DATA_DIR=/tmp/v3verify-data`（端口 3101）；前端 `vite build` 产物由 NestJS 同源 serve。单测 32/32 通过（`npm test`，含 E2E；v2 的 27 个 + 新增 5 个：Plan 通过与拒绝、Team 开、Engineer、Publish/Update）。

## 自测逐项

| # | 项目 | 方法 | 结果 |
|---|---|---|---|
| 1 | Build + Team 关（默认）：接龙全流程 | POST /api/runs → 批架构 → 批发布 | ✅ published；`mode=build, team_mode=0`；发布前草稿在、应用还没建；发布后应用 v1、`published_json == data_json`；种子 6 人 |
| 2 | 改数据 → Update | PATCH /api/apps/:id/data → POST /api/apps/:id/update | ✅ 改完工作区 7 人、线上快照还是 6 人、版本仍是 v1；Update 后 v2，线上快照 = 工作区 7 人 |
| 3 | 拦截演示 1：导出为文件 | POST /api/apps/:id/export-file | ✅ HTTP 200，`{"isError":true,...}` |
| 4 | 导出 JSON（放行） | POST /api/apps/:id/export | ✅ 201，返回完整 data_json（自测脚本一开始按 200 断言误报 1 次，数据本身是对的） |
| 5 | Plan + Team 开：记账全流程 | POST mode=plan teamMode=true → 批计划 → 批架构 → 批发布 | ✅ 计划里 5 人团队（含 Bob）、三道审批；架构 JSON 里 `design` 在 Bob 输出内；published；回放轨迹 >5 条、评估落库、评分 >0；轨迹 actor 里没有 nora/tina/oscar/david |
| 6 | Plan 拒绝回退 | 计划审批点拒绝 | ✅ 状态 `rolled_back` |
| 7 | Engineer：报价一人做完 | POST mode=engineer | ✅ `team_mode=0`；架构审批时草稿已在；批准架构后直接 `awaiting_publish`（跳过 Stage B）；发布成功 |
| 8 | 架构拒绝回退 | 架构审批点拒绝 | ✅ 状态 `rolled_back` |
| 9 | 拦截演示 2：重复调用 | POST /api/runs/repeat-demo | ✅ run 状态 stopped；trace 里第 3 次 `match_template` 被 `repeat_call` 拦下 |
| 10 | 无匹配输入 | 输入“在线商城” | ✅ 状态 stopped，带 guidance |
| 11 | 回放评分 | GET /api/runs/:id/replay | ✅ eval 有值、评分 >0（Team 开那轮）；traces 可查 |
| 12 | 重启后数据还在 | 停服务再起（同一 DATA_DIR） | ✅ 3 个应用都在；接龙 v2、数据 7 人、线上快照 7 人 |
| 13 | 应用列表 | GET /api/apps | ✅ 3 个应用，含 published_version |
| 14 | 单体部署：一个链接打开 | `node apps/api/dist/main.js` | ✅ `/health` 200；`/` 返回 Vite index.html |
| 15 | 手机宽度无横向溢出 | 静态检查 | ⚠️ 未用真机/浏览器探针验证。已做：≤1180px 单列布局、侧栏 360px、`minmax(0,1fr)`、表格内部横向滚动、表单子项 `min-width:0`、JSON 预块 `overflow:auto`。需主 agent 用浏览器在 360px 下实测确认。 |
| 16 | docker compose 干净状态 | — | ❌ **未跑**：本机无任何容器运行时（`docker`/`podman` 均未安装）。Dockerfile 与 compose 文件已静态核对。需在有 Docker 的机器上跑 `docker compose up --build` 验证。 |
| 17 | 前端浏览器实测 | — | ⚠️ 后端 API 全部用 curl 真实驱动；但前端页面只验证了静态资源可达（index.html + JS 200），**未在真实浏览器里点过一遍流程**。需主 agent 用浏览器探针走一遍：三种启动方式、Team Mode 开关、两道审批、Preview 只读、改数据 + Update、两个拦截、回放。 |

## v3 自测中发现并修掉的问题

1. **自测脚本把 NestJS POST 默认 201 当 200 断言**：导出 JSON 接口返回 201，数据本身正确。脚本问题，与工程无关；已在复核时确认数据无误。
2. **`pkill -f` 误杀自己的 shell**：自测命令串里含被匹配的路径。改用 `pkill -f "node [a]pps/api/dist/main.js"`（方括号写法不自匹配）。

## 未完成项

- 真实 LLM 循环本地验证（v4 已接 Kimi kimi-k3，但本机没 key；部署后在 Railway 上配好 `MOONSHOT_API_KEY` 再验，见 v4 一节）。
- docker compose 实机验证（本机无运行时）。
- 浏览器端点击级自测 + 360px 真机溢出验证（需主 agent 探针）。
- Atoms 实测验证的 10 项（清单末尾“需实测项”）：审批步数与拒绝后果等仍以 Demo 设定为准，等 Xiao 的 Atoms 账号实测后再对。

## 主 agent 独立复核（2026-11-23 00:55–00:59，端口 3102，DATA_DIR=/tmp/v3verify2-data）

- 干净构建通过；单测 32/32。
- Plan + Team 开：三道审批走完 → published；plan_json 里 team 为 Mike/Iris/Emma/Bob/Alex；回放 eval score 100（14 步、11 次工具调用、0 错）。
- Build + Team 关、Engineer 各一轮：均 published；Engineer 批架构后直接 awaiting_publish。
- Plan 拒绝 → rolled_back。
- Preview/上线分离：PATCH 工作区 6→7 人后线上快照仍 6 人、版本仍 v2；Update 后 v3、线上 7 人。
- 导出文件拦截 `isError:true`（permission）；重复调用第 3 次被 `repeat_call` 拦下，run stopped。
- 重启后：v3、线上 7 人、工作区 7 人、5 个应用都在。
- 两处自测脚本误报已定位，均非产品 bug：PATCH /data 要包在 `{data: ...}` 里，直接传字段会 500；导出 JSON 返回 201 是 NestJS POST 默认。
- 注意：回放 trace 的 actor 只有 Mike 和 ToolGateway，五人分工体现在 plan_json 和前端时间线里，trace 本身不逐人记 actor。

## v4 自测（2026-11-23，端口 3101，DATA_DIR=/tmp/v4-selftest-data，无 MOONSHOT_API_KEY）

构建：`nest build`（api）+ `tsc -b && vite build`（web）干净通过。单测 37/37（`npm test`，6 个 suite，约 32–45 秒）：32 个原有 + 5 个新增（网关中间件真循环拦截 2 个、云端模型 2 个、无 key 建 run 1 个；model-gateway 原 3 个里“云端插槽未配 key”一题改写为 MOONSHOT_API_KEY 报错）。

真实 HTTP 驱动（无 key）：

| # | 项目 | 方法 | 结果 |
|---|---|---|---|
| 1 | `/health` 模型信息 | GET /health | ✅ 200，`{"status":"ok","model":{"provider":"moonshot","model":"kimi-k3","configured":false}}` |
| 2 | 首页静态 | GET / | ✅ 200（Vite index.html 由 NestJS 同源 serve） |
| 3 | 无 key 建 run | POST /api/runs {"input":"小区团购接龙"} | ✅ 400，`{"message":"MOONSHOT_API_KEY 未设置：请设置环境变量 MOONSHOT_API_KEY（Moonshot 国内站 platform.moonshot.cn 的 key），否则无法创建 run。","error":"Bad Request","statusCode":400}`；runs 表 0 行（单测里也断言了） |
| 4 | repeat-demo 不用 key | POST /api/runs/repeat-demo | ✅ 201 建 run；随后状态 stopped；回放 3 条 trace，第 1、2 次 `match_template` executed，第 3 次 `repeat_call` blocked（`Same tool call repeated 3 times (match_template); stopping to avoid ...`） |
| 5 | 单测里的确定性 E2E | `npm test` agent.e2e.spec.ts | ✅ Build 简化流程两道审批 → published + eval 落库；Plan + Team 开三道审批 → published；Team 开轨迹无 nora/tina/oscar/david；Engineer 一人做完、批架构后直接 awaiting_publish；架构拒绝 / 计划拒绝回退；无匹配停下；无 key 时 createRun 抛 MOONSHOT_API_KEY 错误且不建 run |
| 6 | 网关中间件真循环拦截 | `npm test` tool-gateway-middleware.spec.ts | ✅ 真 `createDeepAgent` + 确定性模型调 `export_file`：工具执行 0 次，模型收到的 ToolMessage 是 `{"isError":true,"step":"permission",...}`；对照组 `match_template` 放行、执行恰好 1 次 |

## v4 自测中发现并修掉的问题

1. **Nest 启动报 `UnknownDependenciesException`（真 bug，v4 自测发现）**：`ModelGatewayService` 的第二个构造参数是测试工厂（函数类型），生产装配不传；Nest 试图按 `Function` 类型注入，找不到 provider，服务起不来。修法：参数上加 `@Optional()`，容器里没有就注 `undefined`。修完重建、`curl /health` 200、自测全过。教训：可选的函数类型构造参数必须显式 `@Optional()`，不能只靠 TS 的 `?`。

## v4 线上实测暴露的两个真 bug（run df4df137，Build 模式 Team 关，2026-11-23 01:52，Railway 已配 key）

Stage A 真模型工作正常：匹配 signup 模板、出需求 + 架构，3 次调用、13,564 token。Stage B 卡住 4 分钟以上，run 一直停在 generating：

1. **Bug 1：`task` 子代理调用两次都报 `Tool execution failed: tool task timed out after 10000ms`。**
   根因不在 deepagents，在我们自己的网关：`ToolGateway.execute` 对所有工具都用同一个 10 秒超时，而 `task` 是子代理派活，子代理内部还要调几次模型，真模型一次调用 30–120 秒（含推理），10 秒必超时。
   修法：网关加按工具区分的超时（`GatewayPolicy.toolTimeouts`），`task` 放宽到 300 秒，其他工具保持 10 秒。`task` 300 秒是上限，正常 30–120 秒内回来。单测：`tool-gateway.spec.ts` 里同样 200ms 的执行，task 跑完、普通工具按默认预算超时；默认策略 task=300_000、其他=10_000。
2. **Bug 2：模型去调没注册的 DeepAgents 默认工具 `ls` / `glob` / `grep`，被网关拦下后不收手，换别的工具继续试，`save_draft` 重复调了 4 次。**
   根因：deepagents 1.17.0 的 `createDeepAgent` 给主 Agent 和子 Agent 都挂 FilesystemMiddleware，默认带 ls / read_file / write_file / edit_file / delete / glob / grep / execute；确定性模型时代模型只调剧本里的工具，这个问题没暴露过。
   修法（三道防线）：
   - 新增 `model-gateway/harness-profile.ts`，注册 harness profile 把文件系统工具从 Agent 的工具列表里拿掉：`registerHarnessProfile('openai', { excludedTools: [ls, write_file, edit_file, delete, glob, grep, execute] })`，另加五个 Kimi 模型名的逐模型 key 做备用。注意一个坑：deepagents 按模型名查 profile 时只读 `model_name` / `modelName`，当前 @langchain/openai 的 ChatOpenAI 这两个字段都是 undefined（模型名只在 `model` 字段里），所以逐模型 key 查不到，真正生效的是 provider 层 "openai"。单测里实测过：第一次只注册逐模型 key 时，probe 抓到的工具列表里 ls / glob / grep 还在；补上 provider 层后才消失。
   - 框架限制：FilesystemMiddleware 是必需中间件排不掉，`read_file` 是它强制保留的（排除列表为空时也会补回），所以 read_file 仍在工具列表里——它不在网关白名单里，调了会被拦下，系统提示里也写明禁掉。
   - 各阶段系统提示加工具规则：只列本阶段有的工具；没有文件系统和 shell；按编号顺序各走一次；工具返回 isError 不许换工具试，同一次调用最多重试一次，save_draft 不许同参数调两次。Stage B 另写死顺序 save_draft → validate_schema → 最终 JSON。
   - 网关注册表拦截的消息改成直接告诉模型：这个工具不存在，不要换别的工具试，按指令里的既定步骤继续。
   单测：`harness-profile.spec.ts`——五个 Kimi 模型名 + openai provider 层的排除列表都断言过；真 ChatOpenAI kimi-k3 实例建的 Agent，wrapModelCall 抓到的工具列表里有自定义工具、没有 ls / glob / grep / write_file / edit_file / delete / execute（构造和绑定工具不联网，probe 在调模型前抛错拦住）。
3. **顺带修：token 用量之前只在阶段结束才更新，卡住的 run 看不到烧了多少。** 改成 usage 中间件（`wrapModelCall`）每次模型调用返回后立刻累计进 `runs.usage_json`；主 Agent 和子 Agent 的中间件栈里都挂了它，子 Agent 的调用也实时计入，不再是“下限”。阶段结束不再另算（单写者，不会重复计）。确定性模型每条 AIMessage 带固定 usage（100 input / 50 output），单测里 E2E 断言 Stage A 结束后 usage_json 的 modelCalls 和 totalTokens 都大于 0。

## v4 修复后复核（2026-11-23 02:05–02:06，端口 3104，DATA_DIR=/tmp/v4fix-verify-data，无 MOONSHOT_API_KEY）

- 干净构建：`npm run build`，api + web 都通过。
- 单测 **44/44**（7 个 suite）：37 个原有 + 7 个新增（网关分工具超时 2 个 + 注册表消息 1 个、harness profile 3 个、usage 增量记录 E2E 1 个）。
- 真实 HTTP：`/health` 200（kimi-k3，`configured:false`）；首页 200；`POST /api/runs` 无 key 仍 400；repeat-demo 建 run 后 stopped，回放 3 条 trace，第三次 `match_template` 被 `repeat_call` 拦下（`is_error=1`）。

## v4 没验证的（写清楚，不编造）

- **真模型循环本地没验证**：本机没有 `MOONSHOT_API_KEY`。`createCloudModel()` 返回 ChatOpenAI（kimi-k3、`https://api.moonshot.cn/v1`）只在单测里用假 key 断言过构造参数，没发过真实请求。部署后主 agent 在 Railway 上复测：走一遍 Build 生成，看 Stage B 的 task 派活是否在 300 秒内回来、模型还调不调 ls / glob / grep、save_draft 是否只调一次、usage_json 是否随调用实时涨，把结果补在这里。
- docker compose 实机验证（本机无运行时；同 v3）。
- 浏览器端点击级自测 + 360px 真机溢出验证（同 v3）。

### 主 agent 独立复核（2026-11-23 01:46–01:47，端口 3103，DATA_DIR=/tmp/v4verify-data，无 MOONSHOT_API_KEY）

- 干净构建：`npm run build`，api（nest build）+ web（tsc -b && vite build）都通过。
- 单测 **37/37**（6 个 suite，约 21 秒）。
- 代码抽查：`createCloudModel()` 用 ChatOpenAI，模型 `kimi-k3`（`MOONSHOT_MODEL` 可改），`baseURL https://api.moonshot.cn/v1`，key 只从 `process.env.MOONSHOT_API_KEY` 读；确定性模型只在测试和工厂里出现，生产装配不传。
- 真实 HTTP：`/health` 200（`configured:false`，model kimi-k3）；首页 200；`POST /api/runs` 400（`MOONSHOT_API_KEY 未设置`，消息写清了国内站 key 不能混用国际站）；repeat-demo 建 run 后 stopped，回放 3 条 trace——前两次 `match_template` 正常，第三次 `is_error=1` 被 `repeat_call` 拦下。
- 仍未验证（同上）：真模型循环——本地没 key，部署后在 Railway 上配好 key 再验。

## v4 线上复测成功（run 5bb54c6d，2026-11-23 02:21，Build / Team 关，真 Kimi 模型）

主 agent 在 Railway 配好 `MOONSHOT_API_KEY` 后线上跑了一遍，整条主链路通了：

- 发布成功，应用 f4d9039f（signup 模板 v1）已上线。
- trace 共 10 条，全 ok；没有 ls / glob / grep，没有超时；`save_draft` 只调一次。
- token 用量 13 次调用、43,006 token，随调用实时涨（usage 中间件每轮调用后累计）。
- 唯一剩下的 bug：回放接口的 eval 一直是 null，尽管 trace 第 10 条 `compute_eval` 显示 ok。根因和修法见下一节。

## v4 eval bug 修复（compute_eval 的 runId 服务端绑定）

- **根因（已核实）**：`tools.ts` 里 `compute_eval` 的 runId 是模型传进来的参数，而模型并不知道当前 run 的 id（大概率传错/编了一个），eval 行写到了错误的 runId 下，`EvalService.latest(正确 runId)` 查不到，回放页 eval 一直是 null。`run_smoke_tests` 的 appId 同样是模型传的，有一样的隐患。
- **修法**：runId 改成服务端绑定——`compute_eval` 的 schema 去掉 runId 字段，工具直接用 `buildTools` 闭包里的 runId；`run_smoke_tests` 的 appId 也一样，review 阶段由 `buildAgentParts(runId, { appId })` 把已发布应用的 id 传进来绑定（没绑定时仍接受模型传的 appId，其他阶段/测试用）。review 阶段的提示词收紧：两步编号、各只调一次、都不带参数。
- **单测**：47/47（8 个 suite），新增 `test/tools-binding.spec.ts` 3 个——模型传错 runId 也写到正确 run 下（`latest(正确)` 非空、`latest(错误)` 为空）、绑定 appId 时模型传错 id 仍测对的应用、没绑定时模型传 appId 照常工作。确定性剧本的 review 一节同步改成无参数调用，e2e 仍走同一套阶段代码。
- **真实 HTTP 自测（2026-11-23，端口 3104，无 key）**：`/health` 200（kimi-k3、`configured:false`）；首页 200；`POST /api/runs` 400（`MOONSHOT_API_KEY 未设置`）；repeat-demo 建 run 后 stopped，第 3 次调用被 `repeat_call` 拦下。真模型循环本地仍验证不了（没 key），不编造。
- **线上复测时重点看**：新跑一遍 Build 生成，进回放页看 eval 是否出现、分数是否合理（成功率、步数、耗时三项都应大于 0）；再看 trace 里 `run_smoke_tests` 和 `compute_eval` 是否各只出现一次。

## v5 前端重做（2026-11-23，apps/web 按 atoms.dev 实测界面重做）

依据：`../atoms-ui-capture-2026-11-23.md`（2026-11-23 12:28–12:33 在 Xiao 的 Chrome 上只看不动，首页 + 项目页布局、尺寸、颜色、每个控件的位置和样子）。后端接口没动（api.ts 原样），只改 `apps/web/src/App.tsx` + `index.css`，preview.tsx 四个模板真实交互原样保留。

改了什么：
- 首页：左侧 350px 边栏（logo、工作区 Sean's Workspace、搜索框、导航 首页/项目/模板、底部用户区 sean）；中央 Agent 头像一排（Mike/Iris/Emma/Bob/Alex 重叠圆圈）；问候“你想创造什么？”32px；白色大圆角主输入框（960px、150px），左下角“+”（附件菜单）、右下角“更多 ∨”（团队模式开关默认关、使用模板创建列 4 个模板、深度研究置灰“未接”）、“构建 ∨”（构建/计划/Engineer 三行）、发送按钮；下方三个快捷药丸（接龙/记账/报价）+“查看全部模板”；再下方项目列表（模板占位图 + 标题 + 创建时间，点卡片进项目页）。
- 项目页：最左侧 70px 图标窄栏；中间约 43% 聊天栏；右侧约 57% 预览区，顶部 64px 顶栏（项目标题下拉改名/删除、历史按钮点开版本列表、收起聊天框；中央分段控件 预览/概览/代码/回放；右侧移动/桌面切换、分享、蓝底圆形“发布”按钮）。
- 聊天栏：顶部“持续构建”进度条卡（分段横条 + x/y，按 pipeline 步骤算）；用户消息右对齐白气泡；Agent 回复（头像 + 当前阶段的人名：Mike 协调 / Bob 架构 / Alex 工程师）；“✓ 已处理 N 步 ∨”可展开步骤列表，每步“灰色说明文字 + 下方浅灰圆角药丸按钮”，无竖向连线，步骤只来自回放 trace 的真实工具调用（kind='tool'），不编步骤；Agent 总结正文只写 run/app 里真实有的数据；“版本 N”卡片（标题 + 克隆按钮是样子）；两道审批卡在聊天栏里（架构/发布，批准/拒绝，拒绝回退）；底部固定 token 用量条（usage_json 的 token 数 + kimi-k3）+ 输入卡（占位文“让智能体团队实现你的想法”，发送后创建新 run，下方写明不会修改当前应用）。
- 预览区：生成的应用占满（preview.tsx 真实交互）；底部中央悬浮白色药丸“设计工具”条（三个按钮是样子）；移动预览切换后预览变 480px 手机框。
- 概览：应用名 + 模板描述、“发布你的 app”卡 + 发布按钮、列表卡（线上应用版本、评估分数、token 用量、导出 JSON）。
- 代码：不伪造代码树，显示“应用数据 JSON”（只读、可复制）+ 本次 run 的工具调用 trace 列表，标题写清来源。
- 回放：版本历史列表（listRuns），点一条重放该 run 的 trace + eval 分数（成功率、步数、耗时、token）。
- 发布面板（点顶栏“发布”按钮弹出）：线上 URL 显示、复制链接、“将你的项目设为公开”开关（附注：本 Demo 链接一直公开，开关只做显示）、底部大号蓝色“发布”按钮——run 在 awaiting_publish 时点它就是确认发布，应用有未发布改动时点它就是 Update 发布新版，已发布且无改动时禁用。
- 分享模态框：公开说明 + 复制链接（真）+ 导出 JSON（真）；私人分享置灰，写明未接。
- 样式 tokens 按实测：背景 #FAFAF8，卡片纯白、1px #E7E5E4 边框、圆角 12–24px；主色 #2563EB，选中标签浅蓝底 #EAF0FF 配蓝字；正文 #111，次要 #6B7280。

自测（2026-11-23，端口 3107，DATA_DIR=/tmp/v5verify-data，无 key）：
- 干净构建：api + web 都通过；单测 47/47（8 个 suite，后端没动）。
- 打包产物核对：新 JS bundle 里有“你想创造什么”“持续构建”“应用数据 JSON”“选择元素”；新 CSS 里有 #FAFAF8；首页 200，引用的 JS/CSS hash 与新构建一致。
- 真实 HTTP：`/health` 200（kimi-k3，configured:false）；`GET /api/templates` 返回 4 个模板；`POST /api/runs` 无 key 仍 400；`POST /api/apps`（signup）建应用成功；PATCH 改数据成功；POST update 发布 v1 成功；POST export 返回该应用 JSON；repeat-demo 建 run 后 stopped，回放 3 条 trace，第 3 次 `match_template` 被拦（is_error=1），eval 为 null（repeat-demo 不跑 review，符合预期）。
- 前端流程覆盖：完整生成 + 两道审批 + 发布 + 回放 eval 由确定性单测 e2e 覆盖（47/47 里含 full run → published + eval 落库）；本次没走真模型（本地没 key），不编造“已验证真模型前端流程”。

### 样子按钮 / 未接清单（点了一律 toast“未接”，不做假功能）

- 首页边栏：底部用户区（sean，未接账号）、铃铛、齿轮设置；导航“模板”只打开模板选择菜单（选模板填输入框，是真的）。
- 首页输入框：语音图标、附件“+”菜单里的上传文件/上传文件夹、深度研究（置灰“未接”）。
- 项目页窄栏：用户头像、齿轮、铃铛、“展开侧边栏”。
- 预览区“设计工具”条：选择元素、修改文本、主题（三个都是样子）。
- 版本卡片：克隆按钮（样子）；复制链接是真的。
- 分享框：私人分享 Pro+（置灰，未接）。
- 发布面板：“将你的项目设为公开”开关只做显示（本 Demo 链接一直公开）。

### 没验证的

- 浏览器点击级自测（本机没有可用的浏览器操作入口）：首页输入 → 生成 → 两道审批 → 发布 → 各 tab 切换 → 分享/发布面板的完整点一遍流程，没点过。部署后主 agent 用浏览器点一遍。
- 360px 真机检查：只做了静态核对（≤760px 单列、边栏变顶栏、窄栏隐藏、面板/模态框 max-width 100%、手机框 max-width 100%、菜单 min-width 300px 在 360px 视口内放得下），没在真机上量过。
- 真模型循环本地仍验证不了（没 key），同 v4。

### v5 线上复测（2026-11-23 13:06–13:23，真模型 kimi-k3）

- run 7f3dd1e3（Build / Team 关）：创建成功，Stage A 真模型跑通（匹配 signup 模板，需求+架构，3 次调用 / 10,564 token），两道审批都通过，发布成功（app 4d185daf），全程 10 次调用 / 32,346 token。
- 问题：回放 eval 仍是 null。trace 只有 8 条（6 个工具 + 2 个审批），run_smoke_tests 调了一次，compute_eval 一次没调。
- 根因：复盘（executeReview）是模型驱动的——prompt 让模型先调 run_smoke_tests 再调 compute_eval，但模型调完第一步就直接收尾了，根本没调第二步。之前那个“服务端绑定 runId”的修复只修了“模型传错 runId 导致 eval 写到别的 run 下”，没修“模型根本不调”这个失败模式。
- 修复（agent.service.ts 的 executeReview）：评估不再交给模型调工具。prompt 里只留 run_smoke_tests 一步；agent 跑完后（try/finally，不管成败）服务端直接调 evalService.compute(runId) 算分落库，并记一条 compute_eval 的 trace，再发 eval_ready。本地验证：干净构建，47/47 测试全过（含 e2e：full run → published + eval 落库）。
- 注意：已发布的 run 7f3dd1e3 的 eval 还是 null（它的复盘在修复前就跑完了），新代码只对之后发布的 run 生效，需再跑一次线上真生成验证。
- 更正（2026-11-23 14:30 后复查）：上面“eval 仍是 null”的结论是查早了。复盘 agent 的第二次模型调用很慢，14:30 复查同一 run 的回放：eval 已在，`{successRate: 1, steps: 8, durationMs: 20983, toolCalls: 6, errorCalls: 0, score: 100}`，compute_eval 的 trace 也在（executed ok），usage 长到 39,005 tokens / 12 次调用。也就是说第一版修复（服务端绑定 runId）本身是有效的，模型最终调了 compute_eval，只是慢。服务端直接算分的改动仍保留：评估不再依赖模型调不调、也不用等几分钟，发布后立刻落库。
- 浏览器点检（2026-11-23 14:26–14:30，线上 v5）：首页、项目页、概览/代码/回放三个 tab、分享/发布面板、移动预览全部可用，无白屏无报错。发现两个小问题，已修（本地干净构建、47/47 测试）：（1）评估分数的数字没显示出来——API 里 score 是 100，但界面只写了成功率/步数/耗时/调用次数，没写“100 分”，已在概览和回放两处把分数补上；（2）首页项目列表首次加载时先闪“还没有保存的应用”，因为加载中和空列表用的是同一文案，已加“正在加载项目…”状态。另有一处内容缺口（未修，需定夺）：聊天总结里说的楼栋房号、自取时间段选择器、组织者统计，预览表单里没有——接龙模板的字段是固定的，模型许诺的比模板能画的多；要补得改模板字段。

### signup 模板补字段（2026-11-23 14:42–14:47，本地）

- 背景：线上 Atoms 实测的团购接龙有称呼/楼栋/手机号/份数、自取时段、接龙序号、组织者看板；我们的 signup 模板只有姓名/份数/备注。按 atoms 实现补齐（含手机号：可选字段，名单里脱敏显示前三后四，中间 ****）。
- 改了什么：schema 增加 `building`（文本，可空，默认 ''）、`slot`（枚举三档：上午 09:00-11:00、下午 16:00-18:00、晚上 18:00-20:00，默认第一项）和 `phone`（文本，可空，默认 ''）；`fields` 和模板描述同步加了楼栋房号/自取时间段/手机号；seed 的 6 条演示报名（小明、阿华、小红、大刘、小美、老陈）补了楼栋房号、时间段和演示手机号（13800000001–13800000006），人数份数不变（6 人共 11 份，三档时间段都有）；preview 的报名表单加楼栋房号输入 + 手机号输入 + 自取时间段下拉，名单加序号/楼栋/手机号（脱敏）/时间段列，新增组织者统计区（共 11 份 · 6 人报名 · 还剩 9 个名额 + 各时间段人数/份数分布，由报名数据现算，不存冗余字段）。另：`updateData` 校验失败改抛 `BadRequestException`，无效数据现在返回 400（以前是 500）。
- 向后兼容：新字段都是 `.optional().default(...)`，老数据（没有这两个字段）仍通过校验；`updateData` 校验走同一 schema；e2e 里推老形状数据的测试仍通过。渲染侧对缺失字段也给了默认值（楼栋空、时间段第一项），非法时间段用第一项兜底。
- draft 数据：不用改 deterministic-scripts.ts 和 agent.service.ts——Stage B 的 draft 一律用 `seedData`（save_draft 省略 data 时取模板 seed），seed 补了字段就自动带上。
- 测试：干净构建，53/53 单测全过（新增 6 个：新字段合法通过、非法时间段拒绝、楼栋非文本拒绝、老数据无新字段仍通过、seed 六条全带合法 building/slot/phone 且共 11 份、phone 可选且老数据仍通过）。e2e 全流程仍通过。
- 本地 HTTP 自测（端口 3109，DATA_DIR=/tmp/phone-verify-data，无 key）：`GET /api/templates` 的 signup fields 含楼栋房号/手机号/自取时间段；`POST /api/apps` 建 signup 应用，seed 六条全带 building/slot/phone；PATCH 老形状数据 200；PATCH 合法新数据（含手机号）200；PATCH 非法时间段 → 400 `{"message":"data invalid: signups.0.slot Invalid option: expected one of \"上午 09:00-11:00\"|\"下午 16:00-18:00\"|\"晚上 18:00-20:00\"","error":"Bad Request","statusCode":400}`（已不是以前的 500）。
- 没验证的：浏览器里点一遍新表单和统计区（本机没有可用的浏览器操作入口）；真模型跑一次新模板全流程（本地没 key）；线上部署后复测（由主 agent 推 + 部署）。

### 模型数据与模板 schema 对不上（2026-11-23 14:57，线上 run 6cae5a4e 暴露，本地修）

- 现象：线上真生成跑通并发布（app 7d89ca4c，5 分钟，eval 95 分），但模型生成的报名数据自带 `items`（购买内容）却没有 `slot`，顶层还多了 deadline/organizer/pickupInfo/title/description/status。`save_draft` 只校验不归一化（`validateData` 的 safeParse 结果被丢弃），原始输入原样进库；预览按模板字段渲染，结果购买内容看不到（备注列空白）、时间段列全是默认上午——和应用自带的“周五晚 18:30-20:30 自提”对不上。
- 改了什么：① `TemplatesService.parseData`：返回解析后的数据（默认值补齐、未知字段去掉）；`validateData` 改走它。② signup schema 加 `items`（购买内容，可选，默认 ''），`fields` 和模板描述同步。③ `save_draft` 存解析后的数据，工具描述钉死数据形状（每个报名必须有 name/count，slot 必须是三个选项之一、按用户要求的自取时间选，building/phone/items/note 可选，不许自造其他字段）；两处 Stage B 提示（主流程 + Engineer 模式）同步加了同一句。④ `updateData`（PATCH）同样存解析后的数据。⑤ preview 名单加购买内容列；`items` 缺失默认空。
- 测试：干净构建，56/56 单测全过（新增 3 个 parseData 测试：缺失字段补默认值、items 保留且未知字段去掉、非法时间段拒绝）。本地 HTTP 自测（端口 3110）：PATCH 模型风格数据（有 items、无 slot、带 deadline/organizer）→ 存下来的数据 slot 已补默认、items 保留、顶层多余字段去掉。
- 注意：eval 发布后不是瞬间就有——回放刚发布时 eval 为 null，30 秒后才有（95 分）。因为 review agent 本身还要跑一次模型调用，算分在它返回后的 finally 里做；比原来“等模型调 compute_eval 好几分钟”快得多，且一定有。发布瞬间就有需要把 review 的模型调用和算分拆开，没做。
