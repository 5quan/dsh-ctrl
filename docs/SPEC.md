# 开发规范与技术架构 Spec

本规范用于保证 `5quan/dsh-ctrl`（后端）与 `5quan/dsh-Go`（前端）在后续迭代中**少返工、边界清晰、可追溯**。

---

## 一、 开发流程规范（Issue → 认领 → 开发 → 验收）

**严禁无 Issue 直接大改核心逻辑。** 所有功能开发与 Bug 修复必须遵循以下 4 步：

### 1. 确立 Issue（必须写明需求与前提）
新建 Issue 时，正文必须包含以下 4 个固定段落：
- **需求背景与目标（Goal）**：解决什么具体问题，为什么需要做，预期行为是什么。
- **前置条件与依赖（Prerequisites）**：
  - 依赖的底层服务版本 / 数据表 / 现有模块（如 `dsh@0.2.2-rc.1`、`ds-bot/src/host/turns.js`）；
  - 是否需要先完成某个前置 Issue；
  - 是否涉及敏感权限、外部网络或服务重启。
- **影响范围（Scope）**：明确标注涉及 `后端 (dsh-ctrl)`、`前端 (dsh-Go)` 还是 `部署 (deploy)`。
- **验收标准（Acceptance Criteria）**：可观测、可验证的 Checklist（包含单元测试或服务器实测路径）。

### 2. 认领与建分支
- 在开始编码前，先在 Issue 下认领（Assign 给自己或评论 `claim`），并基于 `main` 拉出规范分支：
  - 功能：`feat/<issue-number>-<short-name>`
  - 修复：`fix/<issue-number>-<short-name>`

### 3. 开发与自测
- 改动严格收敛在当前 Issue 的 Scope 内，不夹带无关重构。
- `ds-bot/` 改动需补充或运行 `node --test` 单元测试（在 `ds-bot/test/` 下）。
- 涉及服务端部署或配置变更，同步更新 `deploy/` 与 `docs/HANDOFF.md`。

### 4. 提交 PR / 合并并更新文档
- PR 描述中写明 `Closes #<issue-number>` 及实际验证结果（未运行的检查须如实说明原因）。
- 合并后确认服务器上 `ds-bot.service` 运行正常。

---

## 二、 技术架构约束（防返工原则）

### 1. 插件边界原则（不魔改 DSH 核心）
- 严格基于 `@deepseek-ai/dsh` 与 `@deepseek-ai/cordis` 公开插件 API 开发，**不直接修改 `node_modules/@deepseek-ai/dsh` 源码**，确保后续 DSH 升级可平滑迁移。

### 2. 协议与前后端解耦原则
- 与手机端 `dsh-Go` 的通信严格遵守 `POST /api/bot` + `GET /api/bot/feed`（`API_VERSION = 1` + `capabilities` 增量扩展）。
- **前端最小改动原则**：新增后台任务看板、事件摘要、审批交互时，**优先通过 `DS-Bot` 现有的 `show_view` 交互卡片与 `notice` 通道下发**；只有当交互卡片无法承载时，才去 `5quan/dsh-Go` 开原生页面 Issue。

### 3. 持久化与记忆原则
- **对话与知识记忆**：继续沿用 `ds-bot` 现有的 `MEMORY.md` + `[[topic]]` + `steward.js`（8 段式 Handoff）+ `chat-index.sqlite`（FTS5），**不额外引入 Mem0 或外部向量数据库**。
- **任务与断点状态**：长程任务（`Ticket`）、待恢复审批（`pendingAsks`）、事件去重游标统一使用 Node 内置 `node:sqlite` 落盘，保证服务端重启后状态机可精确恢复。

### 4. 第 2 层核心模块演进蓝图（`#2` 指导）
1. **`Router`（`Chief` 单入口）**：负责与用户对话、维护全局记忆、拆解任务并创建/更新 `Ticket`，**不直接承担耗时执行**。
2. **`Ticket + Mandate` 状态机**：每个长程任务持久化 `id / goal / mandate / status / owner_bot / next_step / blockers / artifacts`，并在 `steward.js` 换段时自动注入活跃 Ticket 摘要。
3. **`Worker` 隔离执行**：耗时任务派发到独立 Bot / 工作区执行，结果写回 Ticket 并汇总给 `Chief`。
4. **`Event Bus + Direct-path`**：外部事件（Webhook / 定时巡检 / 任务回调）先经确定性规则过滤噪音，匹配活跃 Ticket 后直接投递对应 Worker，仅关键完成/异常/审批节点唤醒 `Chief` 通知手机端。
