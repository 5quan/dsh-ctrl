# 项目交接文档（Handoff）

> 更新日期：2026-11-22

## 1. 当前定位与环境现状

### 1.1 产品定位调整（2026-11-22 拍板）
- **先做双角色，后加工作群**：先聚焦做好 **秘书（`Chief`，主 Bot，负责沟通、记忆、日结、提醒与拆任务）** + **实施者（`Worker`，负责具体干活）**，工作群留到核心闭环跑稳后再追加。
- **先专心做记忆系统插件（按日期）**：避免记忆、任务、多 Bot 混在一起造成思想负担，下一阶段**独立先把“按日期 + 空闲切日”的记忆系统（M1）做透**，再推进实施者闭环。

### 1.2 开发环境现场（已全面切回 Windows 本地）
- **旧 Linux 云服务器（`47.111.21.130`）**：**已到期，准备释放，不再维护。** 代码与部署配置均已归档在 `dsh-ctrl` 仓库中，无未备份代码。
- **Windows 本地插件开发环境（当前主力）**：
  - Node.js：`v24.9.0`（支持内置 `node:sqlite`），pnpm：`12.3.4`
  - DeepSeek Harness Desktop：`0.2.2-rc.5`（未改动日常桌面配置）
  - 全局 `dsh` CLI：`0.2.2-rc.5`
  - 独立开发 Profile：`C:\Users\5quan\.dsh\profiles\bot-dev`
    - 已通过 `link:D:/project/dsh-plguin/dsh-ctrl/ds-bot` 挂载本地源码；
    - 复用默认 `C:\Users\5quan\.dsh\.credentials.yaml` 与桌面端模型配置（写入在 `profiles/bot-dev/cordis.patch.yml`，未创建 `$DSH_HOME/cordis.patch.yml`）。
  - 常用本地命令：
    ```powershell
    # 启动本地调试网页（改 src/host/ 后重启即可）
    dsh --profile bot-dev --no-open --port 3085

    # 在 ds-bot/ 下跑校验与单测
    npm run lint
    node scripts/build-client.mjs --check
    node --import ./test/harness-resolve.mjs --test test/tickets.test.js
    ```

### 1.3 仓库与 Issue / PR 进度
- **`5quan/dsh-ctrl`**：
  - [`#1`](https://github.com/5quan/dsh-ctrl/issues/1)：`dsh-Go` 自定义渠道协议切换与错误提示跟踪。
  - [`#2`](https://github.com/5quan/dsh-ctrl/issues/2)：`[Epic]` 实现真人式主 Bot（`Chief`）。
  - [`#3`](https://github.com/5quan/dsh-ctrl/issues/3)（当前分支 `feat/3-tickets`，**已实现并测通，待提交合并**）：
    - `ds-bot/src/host/tickets.js`：`tickets.sqlite`（v2 Schema，含 `open/in_progress/waiting_user/blocked/review/done/failed/cancelled`、`mandate`、`acceptance`、`waiting_on`、`wake_condition`、`deadline`、`revision` 乐观锁）、4 个 Ticket 工具、权限与私有 Bot 隔离、`parts.js` 换段自动注入活跃任务摘要。
    - `ds-bot/test/tickets.test.js` 全部通过，`npm run lint` 0 errors。
  - 文档整理完成：旧 `.txt` 已全部转为 Markdown，总指引见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- **`5quan/dsh-Go`**：
  - 已有 [`PR #1`](https://github.com/5quan/dsh-Go/pull/1)（待未来恢复手机端联调时再跟进；当前阶段聚焦后端插件，暂不动 App）。

---

## 2. 关键避坑约束（不要踩的坑）

1. **不要在 `$DSH_HOME/cordis.patch.yml` 写入 `llm-pi-ai` 或 `agent-default-model`**：Home patch 会导致 DSH 拒绝客户端通过 `settings/mutate` 保存模型配置。
2. **CLI 与桌面端共用 `~/.dsh` 时的写锁规则**：`ds-bot` 通过 `~/.dsh/bot/state.lock` 保证单写者；同时开启两个实例时后启动的一方会变为只读（`bot/read-only`）。
3. **不要直接跑 `npm run build`**：`dsh-ctrl` 未包含上游同级 `../link/` 目录，构建前端请用 `node scripts/build-client.mjs`（全量 `npm test` 基线中 `link-bundle.test.js` 和 `phone.test.js` 也因此原因跳过/预期失败）。
4. **不要修改 `node_modules/@deepseek-ai/dsh` 核心源码**：所有能力均以 `ds-bot` 插件方式扩展。

---

## 3. 下一步开发顺序（专注减负版）

1. **收口 Issue #3**：确认无误后将 `feat/3-tickets`（含 Ticket v2 底座与整理后的文档）提交合并到 `main`。
2. **优先独立做「按日期的记忆系统（M1）」**：
   - 基于空闲状态自动切日（如凌晨 `02:00` 后且空闲超过 30 分钟触发昨日日结）；
   - 扫描昨日原文生成不可变日报 `journals/YYYY-MM-DD.md`；
   - 新的一天开启干净上下文，自动拼接近 N 天日报（昨天全文 + 前 2~7 天标题与决定）+ 核心画像 `MEMORY.md` + 活跃 Ticket 摘要。
3. **再做「实施者（Worker）执行闭环」**：一次性 Worker、大输出落盘句柄、单 Ticket 串行队列。
4. **最后完善事件体系、Mandate 硬拦截与工作群**。
