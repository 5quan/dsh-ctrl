# dsh-ctrl

个人助理型 Agent 服务端与核心编排仓库（运行于 Linux 云服务器，通过手机端 [`5quan/dsh-Go`](https://github.com/5quan/dsh-Go) SSH 遥控）。

## 项目目标

打造一个**7×24 在线、单窗口交互、上下文无感延续、支持长程任务与事件驱动**的个人助理：
- 手机端只需与主 Bot（`Chief`）一个窗口对话，无需关心底层会话切换与上下文长度限制；
- 复杂耗时任务由后端拆解为持久化 Ticket 交由后台隔离 Worker 执行，关键节点与审批主动推回手机；
- 借助宿主机工具与浏览器自动化直接处理服务器运维、信息搜集与日常电脑任务。

## 仓库分工

| 仓库 | 职责 |
| :--- | :--- |
| **`5quan/dsh-ctrl`（本仓库）** | 服务端核心：`ds-bot` 后端插件二次开发、Super-agent（Router-Worker + Ticket + 事件总线）、部署配置与开发规范 |
| **[`5quan/dsh-Go`](https://github.com/5quan/dsh-Go)** | 客户端外壳：Flutter 手机 App（SSH Attach-only 遥控连接，不启用手机本地 PRoot 运行时） |

## 目录结构

```text
dsh-ctrl/
├── ds-bot/                 # DS-Bot (v0.3.6) 后端插件源码与单元测试
├── deploy/
│   ├── README.md           # 云服务器 systemd 部署说明
│   └── systemd/
│       └── ds-bot.service  # 宿主机常驻服务配置（监听 127.0.0.1:13080）
└── docs/
    ├── ARCHITECTURE.md     # 项目总说明书、目标架构、设计抉择（ADR）与分期路线图
    ├── SPEC.md             # 开发流程规范（Issue → 认领 → 开发）与技术约束
    ├── HANDOFF.md          # 当前进度、本地环境现场与交接文档
    ├── KNOWN_ISSUES.md     # 已知问题与排查记录
    └── IDEAS.md            # 未来演进灵感备忘
```

## 快速入口

- **项目总说明书与目标架构**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 开发流程与技术 Spec：[docs/SPEC.md](docs/SPEC.md)
- 交接与环境现场：[docs/HANDOFF.md](docs/HANDOFF.md)
- 已知问题记录：[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)
- 未来演进灵感备忘：[docs/IDEAS.md](docs/IDEAS.md)
- 当前核心 Epic：[`5quan/dsh-ctrl#2`](https://github.com/5quan/dsh-ctrl/issues/2)
