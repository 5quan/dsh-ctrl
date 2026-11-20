# 项目交接文档（Handoff）

> 更新日期：2026-11-20

## 1. 当前已完成状态

### 1.1 Linux 云服务器运行端（`47.111.21.130`）
- **运行方式**：宿主机 `systemd` 常驻运行（未套 Docker，便于 Bot 直接观测宿主机资源与进程）。
- **版本**：`@deepseek-ai/dsh@0.2.2-rc.1` + `ds-bot@0.3.6`。
- **关键路径**：
  - 全局命令软链：`/usr/local/bin/dsh` → `/opt/bot-resource-lab-20261117/runtime/bin/dsh`
  - `DSH_HOME`：`/opt/bot-resource-lab-20261117/data/dsbot`
  - `WorkingDirectory`：`/opt/bot-resource-lab-20261117/work/dsbot`
  - 服务单元：`/etc/systemd/system/ds-bot.service`（已 `enable --now`）
  - 监听地址：`127.0.0.1:13080`
- **配置解锁记录**（均保留 `.lab-bak` 备份，未删除原实验文件）：
  - `/opt/bot-resource-lab-20261117/data/dsbot/cordis.patch.yml` → `cordis.patch.yml.lab-bak`
  - `/opt/bot-resource-lab-20261117/data/dsbot/profiles/web/cordis.patch.yml` → `cordis.patch.yml.lab-bak`（已重置为 `[]`）
- **验证情况**：
  - `ds-bot.service` 状态 `active (running)`，`POST /api/bot` 正常响应；
  - 手机端 `dsh-Go` 已通过 SSH `Attach-only`（端口 `13080` + 启动 Token）手动添加模型并成功对话。

### 1.2 客户端与 Issue / PR 进度
- **`5quan/dsh-Go`**：
  - 已提交 [`PR #1`](https://github.com/5quan/dsh-Go/pull/1)（分支 `fix/provider-protocol-and-errors`）：切换兼容协议自动适配 Base URL、Anthropic 404 引导手动添加、`settings/*` 拒绝提示明确化（注：本机无 Flutter SDK，尚未本地跑 `flutter test`）。
  - 已向上游 `ccch1mneyyy/dsh-Go` 提交 Issue：[#1607](https://github.com/ccch1mneyyy/dsh-Go/issues/1607)、[#1608](https://github.com/ccch1mneyyy/dsh-Go/issues/1608)。
- **`5quan/dsh-ctrl`**：
  - [#1](https://github.com/5quan/dsh-ctrl/issues/1)：`dsh-Go` 自定义渠道协议切换与错误提示跟踪。
  - [#2](https://github.com/5quan/dsh-ctrl/issues/2)：`[Epic]` 实现真人式主 Bot（`Chief`）：单入口交互、上下文无感延续与长程任务持久化。

---

## 2. 运维与发布速查

### 查看服务状态与最新登录 Token
每次重启 `ds-bot.service` 会生成新的随机 Token，手机端需同步更新：
```bash
systemctl status ds-bot.service
journalctl -u ds-bot -n 20 --no-pager
```

### 更新 `ds-bot` 插件到服务器
在修改完 `dsh-ctrl/ds-bot/` 后：
```bash
cd ds-bot && npm pack
# 将生成的 ds-bot-*.tgz 上传到服务器后执行：
DSH_HOME=/opt/bot-resource-lab-20261117/data/dsbot dsh plugin --profile web add ./ds-bot-*.tgz
systemctl restart ds-bot.service
```

---

## 3. 关键避坑约束（不要踩的坑）

1. **不要在 `$DSH_HOME/cordis.patch.yml` 写入 `llm-pi-ai` 或 `agent-default-model`**：Home patch 会导致 DSH 拒绝客户端通过 `settings/mutate` 保存任何模型配置。
2. **手机端必须用 SSH 模式（不要用 DSH Remote 中继）**：`ds-harness-remote` 白名单未放行 `dsBot/call` 与 `dsBot/feed`。
3. **Anthropic 兼容端点无 `/v1/models`**：若未合入 `5quan/dsh-Go#1` 的构建版本，点“获取模型”报 404 时直接用下方“手动添加”即可。
4. **不要随意删除 `/opt/bot-resource-lab-20261117/` 下的历史实验文件**，变更前先备份并告知确认。

---

## 4. 下一步开发顺序

1. 按 `docs/SPEC.md` 流程，将 [#2](https://github.com/5quan/dsh-ctrl/issues/2) 拆分为具体子 Issue（先做 **Ticket 持久化状态机 + `Chief` Router 调度**，再做 **外部事件总线 Direct-path**）。
2. 前期所有任务状态与审批展示**优先复用 `DS-Bot` 现成的 `show_view` 与 `notice` 协议**，无需同步大改 `dsh-Go` 前端。
