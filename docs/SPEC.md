# 开发规范与技术架构 Spec

本规范用于保证 `5quan/dsh-ctrl`（编排与外壳）、`5quan/dsh-memory`（记忆与避坑底座）与 `5quan/dsh-Go`（客户端）在后续迭代中**少返工、边界清晰、可追溯**。

---

## 一、 开发流程规范（Issue → 认领 → 开发 → 验收）

**严禁无 Issue 直接大改核心逻辑。** 所有功能开发与 Bug 修复必须遵循以下 4 步：

### 1. 确立 Issue（必须写明需求与前提）
新建 Issue 时，正文必须包含以下 4 个固定段落：
- **需求背景与目标（Goal）**：解决什么具体问题，为什么需要做，预期行为是什么。
- **前置条件与依赖（Prerequisites）**：
  - 依赖的底层服务版本 / 数据表 / 现有模块（如 `dsh@0.2.2-rc.5`、`dshMemory` 契约、`ds-bot/src/host/parts.js`）；
  - 是否需要先完成某个前置 Issue；
  - 是否涉及敏感权限、外部网络或服务重启。
- **影响范围（Scope）**：明确标注涉及 `后端 (dsh-ctrl)`、`记忆插件 (dsh-memory)`、`前端 (dsh-Go)` 还是 `部署 (deploy)`。
- **验收标准（Acceptance Criteria）**：可观测、可验证的 Checklist（包含单元测试或本地 `bot-dev` 实测路径）。

### 2. 认领与建分支
- 在开始编码前，先在 Issue 下认领（Assign 给自己或评论 `claim`），并基于 `main` 拉出规范分支：
  - 功能：`feat/<issue-number>-<short-name>`
  - 修复：`fix/<issue-number>-<short-name>`

### 3. 开发与自测
- 改动严格收敛在当前 Issue 的 Scope 内，不夹带无关重构。
- `ds-bot/` 改动需补充并运行单元测试与校验：
  - `npm run lint`（保证 `ctrl/` 下 0 errors、0 warnings）
  - `node scripts/build-client.mjs --check`
  - `npm run test:ctrl`（及受影响的上游核心单测，如 `test/install.test.js`）
- 涉及联调配置或部署脚本变更，同步更新 `deploy/` 与 `docs/HANDOFF.md`。

### 4. 提交 PR / 合并并更新文档
- PR 描述中写明 `Closes #<issue-number>` 及实际验证结果（未运行的检查须如实说明原因）。
- 若涉及双插件契约变化，同步核对本地 `bot-dev`（端口 `3085`）双插件启动与联调验证。

---

## 二、 技术架构约束（防返工原则）

### 1. 插件边界原则（不魔改 DSH 核心）
- 严格基于 `@deepseek-ai/dsh` 与 `@deepseek-ai/cordis` 公开插件 API 开发，**不直接修改 `node_modules/@deepseek-ai/dsh` 源码**，确保后续 DSH 升级可平滑迁移。

### 2. 上游隔离与 `ctrl/` 目录规范（先隔离、后精简）
- **`ctrl/` 收敛原则**：所有 `dsh-ctrl` 自研后端模块必须放在 `ds-bot/src/host/ctrl/`（通过 `ds-bot/src/host/ctrl/index.js` 统一挂载），自研前端扩展放在 `ds-bot/src/client/ctrl/`，自研单元测试放在 `ds-bot/test/ctrl/`。
- **上游文件最小修改**：上游 `ds-bot` 文件（如 `ds-bot/index.js`、`parts.js`、`approvals.js`、`prompt.js`、`constants.js`）只保留极薄钩子，不把大段业务逻辑混入上游目录。
- **静音优先、集中瘦身**：开发阶段通过配置（如 `memory: false`，会自动同步关闭 `learning`）静音不需要的上游能力；**不要在核心闭环跑通前对高耦合上游模块（如 `roomOf`）做破坏性删改**，待核心功能稳定后再做一次性精准裁剪。

### 3. 持久化与记忆外置原则（单向消费 `dsh-memory`）
- **记忆与避坑经验完全外置**：`dsh-ctrl` **不自建记忆引擎**，运行期配置 `memory: false` 关闭 `ds-bot` 原生 `MEMORY.md` 体系及 `learning.js`；通过单向消费平级插件 `dsh-memory` 暴露的 `ctx.get('dshMemory')` 服务与 `dsh-memory/day-rolled-over` 事件获取档案、实体卡、晨报、避坑教训并投递缓冲区候选。`dsh-memory` 保持零 `ds-bot` 依赖。
- **任务与编排状态持久化**：长程任务（`tickets`）、单次派工（`assignments`）、持久化副作用（`effects`）、待恢复审批与事件去重游标统一使用 Node 内置 `node:sqlite` 落盘，保证宿主重启后状态机可精确恢复。

### 4. 协议与前后端解耦原则
- 与手机端 `dsh-Go` 的通信严格遵守 `POST /api/bot` + `GET /api/bot/feed`（`API_VERSION = 1` + `capabilities` 增量扩展）。
- **前端最小改动原则**：新增晨报确认、待办看板、审批交互时，**优先通过 `DS-Bot` 现有的 `show_view` / `ask_user` 交互卡片与 `notice` 通道下发**；只有当交互卡片无法承载时，才修改 Web 面板或去 `5quan/dsh-Go` 开原生页面 Issue。

### 5. 第 2 层核心模块演进蓝图（`#2` 指导）
1. **模糊会话入口（`Chief`）**：面向用户的单一连续窗口；监听 `dsh-memory/day-rolled-over` 走轻量 `dayRollover` 换段，专注沟通、建单与汇报，**不直接承担耗时执行**。
2. **`Ticket + Assignment + Effects` 状态机**：每个长程任务持久化 `goal / mandate / acceptance / status / next_step / waiting_on / wake_condition / deadline / artifacts / revision`，并将单次派工与持久队列解耦。
3. **一次性 `Worker` 隔离执行**：拉起隔离临时 Session（`worker-<ticketId>`）干净装配上下文执行，大输出落盘为 `artifact://`，`tools/pre-execute` 按 Mandate 硬拦截，隐藏审批由宿主接管；结果以结构化 `ticket_report` 写回后销毁，终态复盘反哺 `dsh-memory`。
4. **确定性事件路由器（`Event Router`）**：Deadline 巡检、IM、邮箱等外部事件先经确定性代码去重过滤，命中活跃 Ticket 直接入队唤醒对应 Worker，仅完成、失败或需人工决策时唤醒 `Chief` 通知用户。
