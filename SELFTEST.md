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

- 真实 LLM 接入（无 key，见 README“先说清楚”一节）。
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
