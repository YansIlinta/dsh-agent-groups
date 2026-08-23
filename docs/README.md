# DSH Agent Groups · 开发文档

根目录 [README](../README.md) 负责回答“这是什么、能做什么、如何开始”；`docs/` 只保留需要长期维护的工程说明、Runtime 协议与设计约束。

## 文档导航

| 文档 | 内容 | 建议读者 |
| --- | --- | --- |
| [Architecture & Invariants](architecture.md) | Domain model、Session / Turn / Task 生命周期、完成规则、通信边界与持久化约束 | Runtime / Host 开发者 |
| [Development Guide](development.md) | 本地环境、构建测试、DSH Web Profile 集成、CI 与开发流程 | 所有贡献者 |
| [Native UI Integration](native-ui.md) | DSH Client Slot、Theme、Native Client 注入方式与 UI 约束 | UI / DSH 集成开发者 |
| [Codex App Server Protocol](CODEX_APP_SERVER_PROTOCOL.md) | Codex persistent thread、turn、steer、approval 与 transport 说明 | Codex Runtime 开发者 |

## 阅读顺序

修改普通业务逻辑时，先阅读 `development.md`；修改 Runtime / Task 状态机时，再阅读 `architecture.md`；只有在修改具体 Provider 或 DSH UI 接入时，才需要进入对应专题文档。

如果使用 Coding Agent，请同时阅读仓库根目录的 [AGENTS.md](../AGENTS.md)。其中的 runtime invariants 是代码约束，不是可选风格建议。

## 文档整理原则

- README 保持产品导向，不堆积内部实现日志。
- 稳定的架构约束、Provider 协议调查、兼容性说明放在 `docs/`。
- 临时调查记录应在结论稳定后合并进对应专题，而不是长期新增 `V0.x_FINAL_2.md` 一类文件。
- 历史版本、修复过程和讨论以 Git History、Pull Request、Issue 为准。
- 文档描述的 provider 能力必须和真实实现一致；Mock 可用不等于真实 Runtime 支持。

## 仓库入口

- [项目首页](../README.md)
- [贡献指南](../CONTRIBUTING.md)
- [Coding Agent 规则](../AGENTS.md)
- [CI Workflow](../.github/workflows/ci.yml)
