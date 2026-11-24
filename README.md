# dsh-ctrl

个人助理型 Agent 服务端与核心编排仓库（当前以 Windows 本地双插件联调为主，规划后续通过家机常驻 + Cloudflare Tunnel 提供 7×24 在线服务）。

## 项目目标

打造一个**单窗口永续对话（模糊会话）、记忆外置、支持长程任务与事件驱动**的个人助理：
- 用户只需与主 Bot（`Chief`）一个窗口对话，底层按日或按长度自动换段（Part），无需关心会话切换与上下文限制；
- 复杂耗时任务由后端拆解为持久化 Ticket，交由一次性隔离 Worker 静默推进，仅在完成、失败或需要人类拍板时唤醒 `Chief`；
- 记忆与避坑经验沉淀统一由独立平级插件 [`5quan/dsh-memory`](../dsh-memory) 提供，`dsh-ctrl` 单向消费其公开 Cordis 契约，专注做好“外壳、编排、任务、拦截与多端入口”。

## 三仓分工

| 仓库 | 职责 |
| :--- | :--- |
| **`5quan/dsh-ctrl`（本仓库）** | Bot 外壳与核心编排：模糊会话（Part 换段）、`tickets.sqlite` 长程任务账本、一次性 Worker 调度、Mandate 硬拦截、确定性事件路由、消费 `dsh-memory` 契约的薄胶水、Web/IM/移动端接入 |
| **`5quan/dsh-memory`（平级插件）** | 独立记忆插件：时间轴日报（`journals/`）、`PROFILE.md`、实体卡（`entities/`）、避坑经验/操作教训（Playbooks/Lessons）、统一缓冲区、晨报摘要、OpenViking 历史索引；对外暴露 `dshMemory` 服务与 `dsh-memory/day-rolled-over` 事件，零 `ds-bot` 依赖 |
| **`5quan/dsh-Go`** | 客户端外壳：Flutter 手机 App（通过 `POST /api/bot` + `GET /api/bot/feed` 遥控连接） |

## 目录结构

```text
dsh-ctrl/
├── ds-bot/                          # 上游 ds-bot (v0.3.6) 底座与 dsh-ctrl 定制扩展
│   ├── index.js                     # 插件入口（在 MODULES 中挂载 ctrl 扩展）
│   └── src/
│       └── host/
│           ├── ctrl/                # dsh-ctrl 自研后端模块（与上游代码严格隔离）
│           │   ├── index.js         # ctrl 模块统一注册入口
│           │   └── tickets.js       # Ticket + Mandate SQLite 状态机与 4 个工具
│           └── ...                  # 上游 ds-bot 宿主机模块（Web/IM/浏览器/Part 引擎等）
│   └── test/
│       └── ctrl/                    # dsh-ctrl 专属单元测试
├── deploy/
│   ├── README.md                    # 本地双插件联调、家机规划与历史归档说明
│   ├── profiles/
│   │   └── bot-dev.patch.yml        # bot-dev 双插件联调示例配置
│   └── archive/
│       └── systemd/ds-bot.service   # 已到期旧 Linux 云服务器配置归档
└── docs/
    ├── ARCHITECTURE.md              # 项目总说明书、三层拓扑、模糊会话与分期路线图
    ├── ROADMAP.md                   # 后续需求路线图与 P0~P3 实施清单
    ├── SPEC.md                      # 开发流程规范（Issue → 认领 → 开发）与技术约束
    ├── HANDOFF.md                   # 当前进度、本地环境现场与交接文档
    ├── KNOWN_ISSUES.md              # 已知问题与排查记录
    └── IDEAS.md                     # 未来演进灵感备忘
```

## 快速入口

- **项目总说明书与目标架构**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **后续需求清单（P0–P3）**：[docs/ROADMAP.md](docs/ROADMAP.md)
- 开发流程与技术 Spec：[docs/SPEC.md](docs/SPEC.md)
- 交接与环境现场：[docs/HANDOFF.md](docs/HANDOFF.md)
- 本地联调与部署说明：[deploy/README.md](deploy/README.md)
- 已知问题记录：[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)
- 未来演进灵感备忘：[docs/IDEAS.md](docs/IDEAS.md)
- 当前核心 Epic：[`5quan/dsh-ctrl#2`](https://github.com/5quan/dsh-ctrl/issues/2)
