# 项目交接文档（Handoff）

> 更新日期：2026-11-24

## 1. 当前定位与环境现状

### 1.1 总体分工与已拍板定位
- **平级三层架构**：`5quan/dsh-memory`（独立记忆插件）与 `5quan/dsh-ctrl`（Bot 外壳、模糊会话、工单与编排）作为平级插件挂载于同一 DSH（Cordis）总线；`dsh-ctrl` **单向消费** `dsh-memory` 的 `dshMemory` 服务与 `dsh-memory/day-rolled-over` 事件，`dsh-memory` 保持零 `ds-bot` 依赖。
- **记忆与避坑全归 `dsh-memory`**：包括每日日报、`PROFILE.md`、`entities/` 实体卡、统一缓冲区、晨报、自动纠偏以及后续避坑经验（Lessons/Playbooks）；`dsh-ctrl` 运行期关闭 `memory: false`（同步静音原生 `learning.js`），只保留执行层的工具/技能（`capabilities`）。
- **先隔离、后精简**：`dsh-ctrl` 自研代码统一隔离在 `ds-bot/src/host/ctrl/`（单测在 `ds-bot/test/ctrl/`），待核心“记忆联动 + 一次性 Worker 闭环 + 事件路由”跑稳后，再集中删减确认无用的 `ds-bot` 上游代码。

### 1.2 开发环境现场（Windows 本地主力）
- Node.js：`v24.9.0`（支持内置 `node:sqlite`），pnpm：`12.3.4`
- DeepSeek Harness Desktop：`0.2.2-rc.5`（未改动日常桌面配置）
- 全局 `dsh` CLI：`0.2.2-rc.5`
- 独立开发 Profile：`C:\Users\5quan\.dsh\profiles\bot-dev`
  - 已通过 `link:D:/project/dsh-plguin/dsh-ctrl/ds-bot` 与 `link:D:/project/dsh-plguin/dsh-memory` 挂载双本地插件（参考 [`deploy/profiles/bot-dev.patch.yml`](../deploy/profiles/bot-dev.patch.yml)）；
  - 复用默认 `C:\Users\5quan\.dsh\.credentials.yaml` 与桌面端模型配置（写入 `profiles/bot-dev/cordis.patch.yml`，绝不创建 `$DSH_HOME/cordis.patch.yml`）。
- 常用本地命令：
  ```powershell
  # 启动本地双插件调试网页（改 src/host/ 后重启即可）
  dsh --profile bot-dev --no-open --port 3085

  # 在 ds-bot/ 下跑校验与单测
  npm run lint
  node scripts/build-client.mjs --check
  npm run test:ctrl
  node --import ./test/harness-resolve.mjs --test test/install.test.js test/learning.test.js
  ```
- **已归档环境**：旧 Linux 云服务器（`47.111.21.130`）已到期释放，原单元文件已移至 [`deploy/archive/systemd/ds-bot.service`](../deploy/archive/systemd/ds-bot.service)。

### 1.3 各仓库进度盘点
- **`5quan/dsh-memory`（平级独立仓库，进度已就绪）**：
  - **M1–M5（含 M5.5）已全部完成**：原文归档与 FTS5、空闲切日不可变日报、按日轮转缓冲区、OpenViking L0/L1/L2 历史总览、`entities/` 实体卡、冷启动引导、每日晨报、轻量自动纠偏、M4 Dream 后台整理与回滚、M5 避坑经验 `lessons/`（`matchLessons` + `target: 'lesson:<名称>'`）、DSH `.volatile()` 实时设置开关，以及公开 Cordis 服务契约 `dshMemory`（`src/service.js`，含 `contractVersion: 1`）与日结事件 `dsh-memory/day-rolled-over`。
- **`5quan/dsh-ctrl`（本仓库）**：
  - [`#1`](https://github.com/5quan/dsh-ctrl/issues/1)：`dsh-Go` 自定义渠道协议切换与错误提示跟踪。
  - [`#2`](https://github.com/5quan/dsh-ctrl/issues/2)：`[Epic]` 实现真人式个人助理（`Chief`）。
  - [`#3`](https://github.com/5quan/dsh-ctrl/issues/3)（已合入 `main` @ `57ab970`）：`tickets.sqlite` v2 状态机、4 个 Ticket 工具、权限隔离、`parts.js` 换段摘要注入。
  - **Phase A 仓库整理已完成**：建立 `ds-bot/src/host/ctrl/` 与 `ds-bot/test/ctrl/` 隔离区并将 `tickets` 归口迁入；整理 `deploy/`；记录完整需求路线图 [ROADMAP.md](ROADMAP.md) 并完成文档校准；验证 `memory: false` 同时静音原生 `memory` 与 `learning`。
  - **P0（`R-1.1` ~ `R-1.4`）已完成并通过单测**：实现 `ctrl/memory-bridge.js`、`ctrl/day-rollover.js` + `parts.js` 轻量 `dayRollover`、`ctrl/briefing.js`（`ctrl_briefing` 工具与防双推去重）、`ctrl/tickets.js` `ctrl_meta` 与终态复盘反哺（`npm run lint` 0 errors，`npm run test:ctrl` 13/13 通过）。
- **`5quan/dsh-Go`**：
  - 已有 [`PR #1`](https://github.com/5quan/dsh-Go/pull/1)（待核心后端闭环跑稳后再恢复联调；当前优先通过 `show_view` 交互卡片承接 UI）。

---

## 2. 关键避坑约束（不要踩的坑）

1. **不要在 `$DSH_HOME/cordis.patch.yml` 写入 `llm-pi-ai` 或 `agent-default-model`**：Home patch 会导致 DSH 拒绝客户端通过 `settings/mutate` 保存模型配置。
2. **CLI 与桌面端共用 `~/.dsh` 时的写锁规则**：`ds-bot` 通过 `~/.dsh/bot/state.lock` 保证单写者；同时开启两个实例时后启动的一方会变为只读（`bot/read-only`）。
3. **不要直接跑 `npm run build`**：`dsh-ctrl` 未包含上游同级 `../link/` 目录，构建前端请用 `node scripts/build-client.mjs`（全量 `npm test` 基线中 `link-bundle.test.js` 和 `phone.test.js` 也因此原因跳过/预期失败）。
4. **不要修改 `node_modules/@deepseek-ai/dsh` 核心源码**：所有能力均以插件方式扩展。
5. **日结换段不要直接调原版 `rt.newPart()`**：原版 `newPart()` 会再调一次 LLM 写 8 段笔记并搬运 16k 旧消息，会与 `dsh-memory` 冻结前缀里的昨日日报重复。需做轻量 `dayRollover` 换段路径。

---

## 3. 下一步开发顺序（详见 [ROADMAP.md](ROADMAP.md)）

1. **P0（Phase 2 · ✅ 已完成，待 `bot-dev` 实机体验）：记忆对接与模糊切日（`R-1.1` ~ `R-1.4`）**
   - `ctrl/memory-bridge.js`：消费 `dshMemory` 服务与 `dsh-memory/day-rolled-over` 事件，支持实体/避坑召回与复盘投递；
   - `ctrl/day-rollover.js` + `parts.js` 轻量 `dayRollover` 换段：收到日结事件且 `Chief` 空闲时无缝切段（跳过旧对话搬运与冗余摘要，带入 `## Active tickets` 并迁移定时任务）；
   - `ctrl/briefing.js`：聚合 `dshMemory.getMorningBriefing()` 与 `tickets.sqlite` 今日到期/待审批工单统一推送晨报，确认后同步调 `confirmBufferItems()` 与 `markBriefingDelivered()` 防双推；
   - `ctrl/tickets.js`：`ticket_update` 支持终态（`done` / `failed`）复盘通过 `memory-bridge` 反哺 `dsh-memory` 缓冲区；
   - 在 `bot-dev`（`3085` 端口）做一轮双插件实机联调体验。
2. **P1（Phase 3 · 当前优先）：一次性 `Worker` 闭环与 Mandate 硬拦截（`R-2.1` ~ `R-2.6`）**
   - 拆分 `Ticket` 与 `Assignment` + 持久化 `Effects` 队列（支持宿主重启恢复）；
   - 实现 `ctrl/ticket-queue.js`（单 Ticket 串行锁 + 全局并发槽 + 人类优先槽）、`ctrl/worker-executor.js`（临时隔离 Session `worker-<ticketId>`、干净装配含 `matchEntities`/`matchLessons`、结构化 `ticket_report`、分层验收）、`ctrl/artifacts.js`（大输出落盘）、`ctrl/mandate-guard.js`（`tools/pre-execute` 硬拦截 + 步数/费用熔断），并扩展 `approvals.js` 接管隐藏 Worker 审批请求。
3. **P2（Phase 4）：主动唤醒与确定性事件路由（`R-3.1` ~ `R-3.2`）**
   - 实现 `ctrl/deadline-watcher.js` 与 `ctrl/event-router.js`：Deadline/停滞巡检（`tickets.listDue()`）、外部事件（IM/邮箱）确定性去重过滤与命中路由。
4. **P3（Phase 5）：前端整合、精准瘦身与常驻部署（`R-4.1` ~ `R-4.3`）**
   - `ds-bot/src/client/ctrl/` 替换记忆面板接 `dshMemory` + 增加极简“待我处理”面板 + 按 Ticket 归因统计消耗；
   - **集中删减确认无用的 `ds-bot` 上游模块**（如原生 `memory*.js`、`learning.js` 等）；
   - 家机常驻 + Cloudflare Tunnel + `dsh-Go` / IM 随时可用；按需评估多员工工作群。
