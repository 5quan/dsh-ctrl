# 部署与本地联调说明

## 1. 当前主力：Windows 本地双插件调试（`bot-dev`）

当前核心开发聚焦在 Windows 本地，将 `5quan/dsh-ctrl`（Bot 外壳、模糊会话、工单与编排）与 `5quan/dsh-memory`（独立记忆插件）作为平级插件同时挂载到独立调试 Profile `bot-dev`：

```powershell
# 1) 挂载两个本地插件源码（均与日常 desktop Profile 隔离）
dsh plugin --profile bot-dev add link:D:/project/dsh-plguin/dsh-ctrl/ds-bot
dsh plugin --profile bot-dev add link:D:/project/dsh-plguin/dsh-memory

# 2) 参考 profiles/bot-dev.patch.yml 关闭 ds-bot 原生记忆与学习轮询
#    (memory: false 会同时静音原生 memory 与 learning 模块)

# 3) 启动本地调试服务（监听 3085 端口；改 src/host/ 后重启即可）
dsh --profile bot-dev --no-open --port 3085
```

完整示例见 [profiles/bot-dev.patch.yml](profiles/bot-dev.patch.yml)。

## 2. 规划中：家机常驻 + Cloudflare Tunnel（Phase 5）

核心闭环稳定后，计划直接在本地常驻主机运行 DSH + `dsh-ctrl` + `dsh-memory`，并通过 Cloudflare Tunnel 提供外网入口供手机端 `5quan/dsh-Go` 与 IM/Webhook 接入，替代固定公网云主机。

## 3. 历史归档：已到期 Linux 云服务器配置

早期测试环境（`@deepseek-ai/dsh@0.2.2-rc.1` + `ds-bot@0.3.6`，监听 `127.0.0.1:13080` 配合 `dsh-Go` SSH Attach-only）已到期停止维护，原单元文件已归档至 [`archive/systemd/ds-bot.service`](archive/systemd/ds-bot.service)。

## 注意事项
- **严禁在 `$DSH_HOME/cordis.patch.yml`（home patch）写入 `llm-pi-ai` 或 `agent-default-model`**，否则 DSH 会锁定配置并拒绝客户端通过 `settings/mutate` 保存模型与 API Key。
- 不要改动用户的日常桌面 Profile（`~/.dsh/profiles/desktop`）。
