<div align="center">

# DSH Agent Groups

**Long-running AI teams, natively inside DeepSeek Harness.**  
让 Claude、Codex 与 DSH Agent 不再只是一次性子任务，而是可以持续协作的长期队友。

[![CI](https://github.com/YansIlinta/dsh-agent-groups/actions/workflows/ci.yml/badge.svg)](https://github.com/YansIlinta/dsh-agent-groups/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/YansIlinta/dsh-agent-groups)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/YansIlinta/dsh-agent-groups?style=social)](https://github.com/YansIlinta/dsh-agent-groups/stargazers)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%20recommended-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-native-5B5BD6)](https://github.com/deepseek-ai/DeepSeek-Harness)

[快速开始](#快速开始) · [核心能力](#核心能力) · [运行时模型](#运行时模型) · [文档](#文档与开发) · [Architecture](docs/architecture.md)

</div>

## 项目简介

**DSH Agent Groups** 是一个运行在 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 内部的多 Agent 协作工作区。

它关注的是让 Coding Agent 实现在同一个 Group 中拥有持续存在的身份、运行时会话、任务历史和共享工作上下文。Leader 可以把工作派发给 DSH Agent、OpenAI Codex 或 Anthropic Claude，并在后续继续追问、纠正、复用同一个会话，而不是每个任务都重新开始。

项目通过 DSH / Cordis 的扩展能力接入，不修改或复制 DeepSeek Harness 源码；Agent Groups 直接出现在原生 DSH shell 中，而不是额外打开一套独立 dashboard。

```text
User
  │
  ▼
Leader ───────── mission / planning / assignment / verification
  │
  ├── DSH Member    ── persistent DSH session
  ├── Codex Member  ── persistent Codex thread
  └── Claude Member ── persistent Claude session
          │
          ▼
 tasks · channel · workspace · notes · artifacts · activity
```

> [!NOTE]
> Agent Groups 仍处于活跃开发阶段。持久会话和多运行时模型已经落地，但跨重启队列恢复、失败重试与长时间运行时耐久性仍在持续加固。

## 它想解决什么

传统的多 Agent 编排很容易退化成：Leader 发出一个 prompt，外部 Agent 运行一次，进程结束，然后把 stdout 当成“任务完成”。这对于长周期 coding workflow 并不够。

Agent Groups 把 **Member、Runtime Session、Turn 与 Task** 分开建模：

```text
Group
  └── Member
       └── Runtime Session
            ├── Turn 1  ← Task A
            ├── Turn 2  ← Leader follow-up
            ├── Turn 3  ← correction / review feedback
            └── Turn 4  ← Task B
```

因此同一个 Codex / Claude / DSH Member 可以持续工作：先实现功能，再接受 review，再修复，再继续接下一个相关任务，而不是每次都丢失上下文。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **长期队友** | 一个 Group Member 持有自己的 runtime session，可跨多个任务继续同一段 provider conversation。 |
| **多运行时团队** | 同一团队可以混合 DeepSeek Harness、OpenAI Codex 与 Anthropic Claude。 |
| **Leader 编排** | Leader 负责拆解 mission、创建任务、分派成员、跟进结果、重新打开任务和最终验证。 |
| **持久化工作区** | Group、mission、task、消息、runtime metadata、notes、artifacts 与 activity 等状态进入持久层。 |
| **DSH 原生界面** | Agent Groups 入口位于 DSH sidebar，并直接在 DSH shell 中渲染，不使用 iframe 或第二套应用壳。 |
| **明确的生命周期** | Process、session、turn 和 task 生命周期彼此区分；进程退出不会被静默等同为任务成功。 |
| **可继续的 Coding Agent** | Codex thread 与 Claude session 可以被后续任务、Leader follow-up 和修正继续复用。 |
| **通信边界** | Leader ↔ Member 私聊允许；Member ↔ Member 私聊在 host service 层被限制，而不是仅依赖 prompt 约束。 |
| **实时活动流** | Workspace 通过 API 与 SSE 展示任务、运行时和协作状态变化。 |

## 运行时模型

不同 provider 的会话机制并不一样，Agent Groups 在上层提供统一的 session / turn 语义，同时保留 provider 自己的 resume 与 steering 能力。

| Runtime | Session identity | 持续协作方式 |
| --- | --- | --- |
| **DeepSeek Harness** | DSH member session | 原生持久 Member；恢复时保留角色、模型与 reasoning 配置。 |
| **Codex** | Codex App Server thread | 新任务继续复用同一个 thread；进行中的工作可使用 provider-native steering。 |
| **Claude** | Claude Agent SDK session id | 后续 turn 使用 `options.resume` 继续同一 Claude conversation。 |

Runtime 层还负责归一化事件、中断、pending approval / input，以及 provider-specific resume 行为。更严格的生命周期与完成条件见 [Architecture](docs/architecture.md)。

## 原生工作区

Agent Groups 通过 DSH client plugin system 注入：

- `sidebar.footer.action`：加入 Agent Groups 入口。
- `shell.overlay`：在保留 DSH shell、主题与导航的前提下承载完整工作区。
- DSH UI primitives 与 `--dsw-alias-*` design tokens：尽可能复用 DSH 现有视觉体系。
- `/groups/api/*`：提供工作区数据 API。
- `/groups/api/events`：通过 SSE 推送实时变化。

当前工作区包含：

**Overview · Tasks · Team · Channel · Leader Chat · Workspace · Activity · Profiles · Team Configuration**

实现说明见 [Native UI](docs/native-ui.md)。

## 快速开始

### 环境要求

- Node.js **20+**（CI 使用 Node.js 22，推荐本地同样使用 22）
- 本地安装的 DeepSeek Harness
- Bash，用于 web profile 安装与 relaunch 脚本
- 可选：已认证的 `codex`，用于 Codex Member
- 可选：可用的 Claude / Claude Agent SDK 环境，用于 Claude Member

当前 CI 的 DSH 兼容目标为 **DeepSeek Harness `0.1.0-rc.6`**。更新版本需要重新验证后再视为正式支持。

### 获取与构建

```bash
git clone https://github.com/YansIlinta/dsh-agent-groups.git
cd dsh-agent-groups

cd packages/host
npm install
cd ../..

npm run build
npm run typecheck
npm test
```

### 安装到 DSH Web Profile

```bash
npm run install-web-profile
npm run relaunch-web
```

安装脚本会构建 native client bundle，将 `@dsh-agent-groups/host` 安装到本地 DSH profile module tree，写入 `group-leader` / `group-member` presets，并把插件加入 web profile patch。

DSH 重启后，在原本的 Web UI sidebar 底部打开 **Agent Groups** 即可。

## 基本使用流程

1. 启动或选择一个 **Agent Group · Team Lead** session。
2. 打开 **Agent Groups**，创建新的 Group。
3. 选择 team template，或手动配置角色和 runtime。
4. 输入整个团队要完成的 mission。
5. Leader 将 mission 拆成任务并分配给不同成员。
6. 在 Tasks、Team、Channel、Leader Chat、Workspace 和 Activity 中查看执行过程。
7. 对进行中的成员追加要求、排队后续任务、处理 approval / input，或在必要时 interrupt 当前 turn。
8. Leader 对完成声明进行验证，再决定是否结束 mission。

## 文档与开发

如果只是体验项目，README 到这里已经足够。协议、生命周期不变量和开发细节统一放在 `docs/`，避免首页变成实现日志。

| 文档 | 内容 |
| --- | --- |
| [Documentation Index](docs/README.md) | 文档入口与阅读顺序。 |
| [Architecture](docs/architecture.md) | Domain model、runtime/session lifecycle、completion rules 与 persistence invariants。 |
| [Development](docs/development.md) | 本地开发、build/test、CI 与 DSH 集成方式。 |
| [Native UI](docs/native-ui.md) | DSH client slot、theme 与原生工作区接入。 |
| [Codex App Server Protocol](docs/CODEX_APP_SERVER_PROTOCOL.md) | Codex persistent runtime transport 的协议记录。 |

从仓库根目录运行：

```bash
npm run build
npm run typecheck
npm test
npm run build:native
```

集成与耐久性验证脚本：

```bash
node scripts/verify-durability.mjs
node scripts/demo-v02.mjs
```

## 仓库结构

```text
.
├── packages/
│   ├── host/                  # host services, tools, runtime adapters, API, native client
│   └── profiles/              # group-leader / group-member presets and profile fragments
├── scripts/                   # build, install, relaunch, demo, durability helpers
├── docs/                      # architecture, development and provider protocol notes
├── .github/workflows/         # CI
├── AGENTS.md                  # coding-agent rules and repository invariants
├── CONTRIBUTING.md            # contribution workflow
└── README.md                  # product entry point
```

`packages/host/src/` 的主要边界：

```text
src/
├── group-host.ts              # product/service facade + runtime coordination
├── group-service.ts           # durable group behavior
├── task-service.ts            # task lifecycle
├── channel-service.ts         # group communication
├── runtime/                   # DSH / Codex / Claude runtime abstractions
├── native-client/             # DSH-native Agent Groups workspace
├── web/                       # API + SSE
├── persistence.ts             # persistence setup
└── store.ts                   # durable storage layer
```

## 项目状态

目前重点不是继续增加更多 provider，而是加固长期运行能力：

- queued turn 在 host restart 后的完整恢复；
- active / queued task 状态保持无歧义；
- transient turn-start failure 后的确定性 retry；
- runtime / task 生命周期之间更严格的完成判定；
- 长周期团队执行下更可靠的恢复与审计。

版本演进与实现历史以 Git history、pull request、issue 和 release 为准，不在 README 中维护不断膨胀的 V0.x changelog。

## Contributing

欢迎提交 Bug、runtime compatibility 结果、回归测试以及范围明确的 pull request。

涉及 runtime/session 语义的修改，请先阅读 [AGENTS.md](AGENTS.md)、[CONTRIBUTING.md](CONTRIBUTING.md) 与 [Architecture](docs/architecture.md)。这些生命周期不变量属于产品行为的一部分，应由测试保护。

## 致谢

DSH Agent Groups 建立在这些工具与生态之上：

- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)
- [OpenAI Codex](https://github.com/openai/codex)
- [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)

感谢这些项目提供的 runtime、扩展接口和 agent tooling 基础。

## License

本项目基于 [MIT License](LICENSE) 开源。
