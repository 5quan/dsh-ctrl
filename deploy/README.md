# 服务端部署记录（DSH + DS-Bot）

## 架构说明
- **运行端**：Linux 云服务器宿主机直接运行 `@deepseek-ai/dsh@0.2.2-rc.1` + `ds-bot@0.3.6`，监听 `127.0.0.1:13080`。
- **交互端**：手机端 `dsh-Go` 通过 **SSH Attach-only** 模式连接远端 `13080` 端口。

## systemd 服务
单元文件见 [`systemd/ds-bot.service`](systemd/ds-bot.service)：

```bash
# 查看状态与当前启动 Token
systemctl status ds-bot.service
journalctl -u ds-bot -n 20 --no-pager
```

## 注意事项
- 不要在 `$DSH_HOME/cordis.patch.yml`（home patch）中硬编码 `llm-pi-ai` 或 `agent-default-model`，否则 DSH 会锁定配置并拒绝客户端通过 `settings/mutate` 保存模型与 API Key。
- 压测遗留的原始配置已备份为 `cordis.patch.yml.lab-bak`。
