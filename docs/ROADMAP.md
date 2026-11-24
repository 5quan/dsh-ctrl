# `dsh-ctrl` 后续需求路线图与实施清单（Roadmap）

> 创建日期：2026-11-24  
> 定位：对应 [ARCHITECTURE.md](ARCHITECTURE.md) 七大阶段的可落地需求清单，按依赖关系排为 **P0 → P3** 四个批次；每个需求项可直接拆为独立 Issue 推进（开发规范见 [SPEC.md](SPEC.md)）。

---

## P0（Phase 2 · ✅ 已完成）：记忆对接 & 模糊会话日结

> **目标**：把已在 `5quan/dsh-memory` 就绪的记忆契约与 `dsh-ctrl` 的 `tickets.sqlite` 连成一体，在本地 `bot-dev`（`3085` 端口）跑通每天可用的个人秘书闭环。

| 编号 | 需求项 | 落点文件 | 核心内容 | 验收标准 |
|---|---|---|---|---|
| **R-1.1** | 记忆契约薄胶水 | `ds-bot/src/host/ctrl/memory-bridge.js` | 单向获取 `ctx.get('dshMemory')`（未装插件时优雅降级不报错），封装统一能力：订阅 `dsh-memory/day-rolled-over`、读晨报、按文本召回实体卡与避坑经验（`matchEntities` / `matchLessons`）、向缓冲区投递候选记忆 | 单测覆盖“有/无 `dshMemory` 服务”双场景；`bot-dev` 双插件同启无报错 |
| **R-1.2** | 模糊会话：空闲切日轻量换段 | `ds-bot/src/host/ctrl/day-rollover.js` + `parts.js` 薄钩子 | 在 [parts.js](../ds-bot/src/host/parts.js) 新增轻量 `dayRollover` 换段模式：**跳过**原版 LLM 8 段摘要和 16k 旧消息搬运（由 `dsh-memory` 冻结前缀兜底），仅带 `## Active tickets` 并迁移 `schedules`；收到日结事件时，Chief 空闲即切、忙碌则待本回合结束再切 | 模拟日结事件触发换段后：零额外 LLM 摘要调用、新 Part 含活跃 Ticket、旧 Part 历史无缝上翻可见；同日重复事件幂等 |
| **R-1.3** | 统一早间晨报与去重确认 | `ds-bot/src/host/ctrl/briefing.js` | 每日首轮聚合 `dshMemory.getMorningBriefing()`（昨日亮点 + 缓冲区待确认项）与 `tickets.sqlite`（今日到期 / `waiting_user` / `review` 工单），提供 `ctrl_briefing` 工具并引导 `show_view` 单卡片展示；在 `next()` 前协调 `markBriefingDelivered()` 防与 `dsh-memory` 双推 | 单测验证无论加载顺序如何不双推、勾选通过 `confirmBufferItems()` 落盘、非用户开场不误推 |
| **R-1.4** | Ticket 终态复盘反哺记忆 | `ctrl/memory-bridge.js` + `ctrl/tickets.js` | `ticket_update` 支持传入 `retrospective` / `retrospective_target` / `retrospective_tags`，工单转 `done` / `failed` 时自动通过 `dshMemory.submitBufferCandidate(...)` 投递进缓冲区等确认（默认 `failed` 归入 `lesson:<title>`、`done` 归入 `note`，绝不直写 `PROFILE.md`，隐私 Bot 隔离不外泄） | 终态复盘后 `dsh-memory` 当日 `buffer/` 出现对应 `pending` 条目；非终态与隐私 Bot 不外泄 |

---

## P1（Phase 3 · 当前优先 / 核心主战场）：一次性 Worker 闭环 & 安全硬边界

> **目标**：让 `Chief` 真正脱手脏活累活——由后台隔离、用完即弃的 Worker 静默推进长程任务，做到**可控、抗重启、防越权、防卡死、防烧钱**。

| 编号 | 需求项 | 落点文件 | 核心内容 | 验收标准 |
|---|---|---|---|---|
| **R-2.1** | `Assignment` 与持久化队列 `Effects`（✅ 已完成 `#7`） | `ctrl/tickets.js`（Schema v2 → v3） | 参考 `dsh-superagent` Stored Work：拆分长期 `Ticket` 与单次派工 `Assignment`（`pending/running/ended/interrupted`），新增持久化 `effects` 队列（先落库、commit 后执行，带幂等键与退避重试）与重启恢复逻辑 | 模拟执行中宿主重启，中断的 Assignment 自动识别并带 recovery note 恢复或回报，不丢不重 |
| **R-2.2** | 单 Ticket 串行队列与并发槽（✅ 已完成 `#7`） | `ctrl/ticket-queue.js` | 单 Ticket 严格 Actor 串行互斥 + `revision` 乐观锁防并发写乱；全局限制 `maxWorkers` 并发槽，并预留 **+1 人类优先槽**保证用户指令不被后台任务堵死 | 同 Ticket 并发入队严格串行；槽位打满时人类唤醒仍可优先拿到执行槽 |
| **R-2.3** | 一次性隔离 Worker 与结构化回报（✅ 已完成 `#9`） | `ctrl/worker-executor.js` | 新增派发工具（如 `ticket_dispatch`）；通过 `ctx.sessionController.create` 建隔离 Session（`worker-<ticketId>`，**不写入 `state.bots`**，带子会话标记避开 `dsh-memory` 原文污染）；仅装配 `Ticket + Mandate + Acceptance + 命中实体/避坑卡 + artifact 句柄`；提供结构化 `ticket_report` 工具申报 `progress/waiting_user/review/blocked/failed`（严禁从自由文本猜状态）；跑完即归档销毁；过程静默，仅关键节点唤醒 Chief | Chief 派发真实子任务后，Worker 静默执行、写回 `artifacts` 并销毁，Chief 仅收到一条清晰汇报且上下文零污染 |
| **R-2.4** | 工具大输出落盘句柄（✅ 已完成 `#7`） | `ctrl/artifacts.js` | 超过阈值的工具返回（命令日志、长文件、网页正文）自动写盘至 `<home>/artifacts/`，上下文中仅留摘要 + `artifact://<id>` 句柄与按段翻页读取工具（同时保护 Chief 与 Worker） | 50KB 级工具输出被自动压缩为简短摘要 + 句柄，并能按需分段回查原文 |
| **R-2.5** | Mandate 硬拦截、隐藏审批接管与熔断 | `ctrl/mandate-guard.js` + `approvals.js` 薄钩子 | 1. 挂 `tools/pre-execute` 对 Worker 做结构化 Mandate 硬校验（目录白名单、禁跑命令/外发拦截），越权强制转 `waiting_user`；<br>2. 扩展 [approvals.js](../ds-bot/src/host/approvals.js) 接管隐藏 `worker-<ticketId>` 的 `approval/request` 转发给 Chief/通知，防隐藏会话永久挂死；<br>3. 单次 Assignment 步数/Token 熔断 | Worker 触发越权操作或工具审批时，Chief 立即收到可操作审批卡，批准/拒绝后 Worker 正常继续或退出 |
| **R-2.6** | 分层验收机制（✅ 已完成 `#9`） | `ctrl/worker-executor.js` | `review` 阶段支持：① 机器可判定验收（自动跑校验命令/检查产物）→ 通过直转 `done`，失败打回 `in_progress` 附报错；② 独立评审会话；③ 业务/高风险决策弹 `show_view` 交人拍板 | 机器校验未通过时阻止“假完成”并自动打回重做 |

---

## P2（Phase 4 · 主动耳目）：定时巡检与确定性事件路由

> **目标**：从“被动聊天”升级到“主动盯进度、接外部消息，该推进的自动推，该拍板的才叫你”。

| 编号 | 需求项 | 落点文件 | 核心内容 | 验收标准 |
|---|---|---|---|---|
| **R-3.1** | Deadline 与停滞巡检 | `ctrl/deadline-watcher.js` | 定时扫描 `tickets.listDue()` 及超长停滞（`in_progress` / `waiting_user` 超时）工单，幂等触发队列唤醒或推送提醒给 Chief（不重复刷屏） | 到期工单自动提醒或唤醒，同一到期窗口不重复触发 |
| **R-3.2** | 确定性外部事件路由器 | `ctrl/event-router.js` | 借鉴 `dsh-superagent` 的 `Source → Trigger → Gate → Ticket`：代码级去重 + 规则过滤，命中活跃 Ticket 的 `waiting_on / wake_condition` 直投队列唤醒 Worker，未命中且符合规则的再交 Chief；首期接入 `ds-bot` 现有 **邮箱（`connectors/mail`）** 与 **IM（`im/platforms/`）** | 匹配活跃 Ticket 的外部消息直达 Worker 不打扰 Chief；无关噪声消息被确定性丢弃 |

---

## P3（Phase 5 · 收口与日常形态）：前端整合、大瘦身与常驻部署

> **目标**：把日常体验打磨到位，并把确认不用的上游代码一次性清干净。

| 编号 | 需求项 | 落点文件 | 核心内容 | 验收标准 |
|---|---|---|---|---|
| **R-4.1** | 前端记忆面板 & “待我处理”极简视图 | `ds-bot/src/client/ctrl/` + `usage.js` | 1. 替换旧 `memory-panel.js` 改接 `dshMemory`（查看/编辑 `PROFILE.md`、实体卡、避坑卡、日报、勾选缓冲区）；<br>2. 新增极简“待我处理”角标/面板（聚合待审批/到期 Ticket + 待确认记忆，健康态不占空间）；<br>3. 前端弱化 Part 术语，改为按日期分隔连续时间线；<br>4. 扩展 `usage.js` 支持按 Ticket / Worker 归因统计费用 | 侧栏可直接治理记忆与待办，后台 Worker 成本清晰可查 |
| **R-4.2** | 上游 `ds-bot` 精准瘦身（阶段 B） | `ds-bot/` | 核心闭环跑稳后，按实测清单集中删除确认不用的上游模块（原生 `memory*.js`、`learning.js`、不用到的 IM 平台/群聊 UI 等）与对应死代码 | 删减后 `lint`、`build-client --check`、`test:ctrl` 与本地 `bot-dev` 全流程无回归 |
| **R-4.3** | 家机常驻、多端与可选扩展 | `deploy/` + `5quan/dsh-Go` | 家机常驻 + Cloudflare Tunnel 穿透；恢复联调手机端 `dsh-Go` 与微信/飞书入口；按需决定是否接入 `local-agents/`（Claude Code / Codex）作为高复杂编码 Worker 引擎，以及是否开启多员工工作群 | 手机/IM 外出随时派活，家机后台静默跑完推回结果 |

---

## 配套协同：`5quan/dsh-memory` 仓库现状

| 能力 | 状态 | 与 `dsh-ctrl` 的衔接说明 |
|---|---|---|
| **M1–M3 基础记忆与服务契约** | ✅ **已完成** | 已提供 `dshMemory`（`contractVersion: 1`）、`dsh-memory/day-rolled-over` 事件、晨报与缓冲区确认、实体卡召回与 `submitBufferCandidate` |
| **M4 Dream 后台整理与安全守卫** | ✅ **已完成** | 已具备双通道 Dream、`retired.jsonl` 通用回滚、凭据拦截（`guard.js`）与完整遗忘 |
| **M5 避坑经验层（`lessons/`）与 `matchLessons`** | ✅ **已完成** | 已原生支持 `target: 'lesson:<名称>'`（带 `tags` / `triggers` / `expires`）与 `dshMemory.matchLessons(text, { tags, maxTokens })`，供 `R-1.4` 复盘回灌与 `P1` Worker 装配直接消费 |
| **M5.5 实时设置与后续优化（Issue `#9`）** | ✅ 已完成 / 规划中 | DSH 原生 `.volatile()` 实时设置已可用；`dsh-ctrl` 无需等待 `dsh-memory` 侧即可全速推进 P0–P3 |
