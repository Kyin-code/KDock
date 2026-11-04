# Agent 会话同步参考项目与许可证调研

> 状态：**调研记录，尚未复制或引入这些项目的代码**
>
> 调研日期：2026-11-04
>
> 本文件记录 KDock 会话同步设计可参考的项目、版本、许可证和具体借鉴点。
> 后续如果实际复制代码、协议文本或数据文件，必须同步更新根目录 `NOTICE` 和
> 第三方许可证清单。

## 1. 调研结论

这批项目没有一个是 KDock 所需的完整“多设备单写者会话接管”实现。

最值得参考的是：

1. PPGP 的“最小可恢复状态”和 handoff 思路；
2. Agent Bud-E 对多设备同步边界的拆分；
3. Cairntir 的原记录、可移植证据和 host-neutral memory 设计；
4. USMC 对 SQLite、多进程边界和 provenance 的工程处理；
5. LlamaIndex Discussion #20381 的 typed state、event sourcing 和 checkpoint 组合。

KDock 不应直接照搬某个项目的完整架构。KDock 的核心区别是：

- 有真正的 LLM 和工具执行；
- 有会话租约；
- 有 fencing token；
- 有用户确认的工作区链接；
- 有 LAN MAIN；
- 有可接管的只读副本。

## 2. Fatboy-coder/ppgp

| 项目 | 信息 |
| --- | --- |
| 仓库 | <https://github.com/Fatboy-coder/ppgp> |
| 名称 | Portable Persistent Goal Protocol（PPGP） |
| 调研版本 | v0.1.3 |
| 调研 commit | `89529061ac5850584126aeed1068310748155187` |
| 许可证 | MIT |
| 版权声明 | Copyright (c) 2026 Fatboy-coder and PPGP contributors |
| 形态 | 规范、Agent Skill、无依赖 CLI、测试和 benchmark |

PPGP 提供 `CITATION.cff`。如果后续在设计文档或发布说明中正式引用它，
应写明调研版本为 v0.1.3。

### 可参考内容

PPGP 把长任务的恢复状态压缩成一份仓库可见的 `ACTIVE_GOAL`，共 13 个字段：

```text
GOAL
WHY
PHASE
DEFINITION_OF_DONE
FROZEN_DECISIONS
INVARIANTS
VERIFIED_CURRENT_STATE
COMPLETED
REMAINING
BLOCKERS
HUMAN_AUTHORITY_REQUIRED
VERIFICATION_EVIDENCE
NEXT_EXECUTABLE_ACTION
```

KDock 可以借鉴其中一部分作为 `ContinuityCheckpoint`：

- 当前目标；
- 已完成内容；
- 待完成内容；
- 已验证事实；
- 阻塞项；
- 下一步可执行动作；
- 需要人工授权的边界。

这个 checkpoint 适合在以下时机生成：

- 一轮任务完成；
- 上下文压缩前；
- 执行设备准备释放租约；
- 新设备接管前。

PPGP 的 handoff 原则也值得保留：

- handoff 是紧凑状态，不重放完整聊天；
- handoff 不能替代权威状态和证据；
- 接收方应能通过当前状态继续，而不是重新听一遍故事。

### 不直接采用的部分

- 不把 Markdown `ACTIVE_GOAL` 作为 KDock 的唯一权威状态；
- 不引入 PPGP 的完整生命周期和 CLI；
- 不让 repository-visible 文件覆盖 KDock 的会话事件流；
- 不把 PPGP 的 13 字段要求强加给所有普通会话。

### 致谢候选名称

```text
PPGP — Portable Persistent Goal Protocol
https://github.com/Fatboy-coder/ppgp
MIT License
Copyright (c) 2026 Fatboy-coder and PPGP contributors
```

## 3. LAION-AI/agent-bud-e

| 项目 | 信息 |
| --- | --- |
| 仓库 | <https://github.com/LAION-AI/agent-bud-e> |
| 名称 | Agent Bud-E |
| 调研 commit | `30661542f9891f9207caf0afca58c62a8df0db19` |
| 许可证 | Apache-2.0 |
| 形态 | 以 README/white paper 为主的设计文档，不是可直接集成的 KDock 依赖 |

### 可参考内容

Agent Bud-E 将记忆分为：

- episodic memory；
- semantic memory；
- procedural memory。

其中对 KDock 最有用的是“可移植、可独立版本化、可在沙箱外备份或同步”的文件边界，
以及对多设备同步方案的对比：

1. 手动导出/导入；
2. iCloud/Google Drive 同步；
3. 自建同步服务器；
4. 端到端加密云同步。

Agent Bud-E 对首版的建议是：先设计 sync-friendly 的数据结构，不急着实现完整云同步。
这与 KDock 当前先做事件信封、manifest 和只读副本原型的顺序一致。

其他可借鉴点：

- 状态文件独立版本化；
- 内存/上下文分层，不把所有历史塞进一个 prompt；
- 隐私数据应有明确的“仅本地”标记；
- API Key 存在系统安全存储中，不进入普通文件；
- 内容被同步前应该允许用户检查和排除。

### 不直接采用的部分

- Agent Bud-E 不是 KDock 的 runtime 依赖；
- 不采用 Flutter；
- 不采用 iCloud/Google Drive 作为 KDock 首版同步方式；
- 不把 triplet memory 结构直接搬进 KDock 会话存储；
- 不采用它的 passive audio 等 companion 功能。

### 致谢候选名称

```text
Agent Bud-E
https://github.com/LAION-AI/agent-bud-e
Apache License 2.0
```

## 4. pnmcguire480/cairntir

| 项目 | 信息 |
| --- | --- |
| 仓库 | <https://github.com/pnmcguire480/cairntir> |
| 名称 | Cairntir |
| 调研 commit | `0a4bed36d5adeac1b3e994d47fc05edf2c56e69f` |
| 许可证 | MIT |
| 版权声明 | Copyright (c) 2026 Patrick McGuire |
| 形态 | Python、SQLite、MCP server、CLI、测试 |

### 可参考内容

Cairntir 是本地优先、跨 Agent 的持久记忆 MCP server，适合参考“记忆不是聊天记录”的边界。

值得关注的设计：

- wing / room / drawer 的逻辑层级；
- 原记录和派生摘要分开；
- 修正通过新记录 supersede 旧记录；
- 不要原地改写历史证据；
- 每条记录保留 provenance；
- handoff 有预算，而不是无限追加历史；
- portable evidence 使用稳定 ID、hash 和关系映射；
- 导入内容默认是不可信的，不自动获得本地授权；
- 明确区分“原记录”和“本地工作流状态”。

对 KDock 的直接启发：

1. 同步事件应追加，不修改旧事件；
2. 工具结果和工作区 revision 应有内容 hash；
3. 本地摘要应可重建，不应成为唯一事实来源；
4. 从其他设备导入的内容不能自动获得本机工具权限；
5. handoff 要控制长度，不能每次全量重放。

### 不直接采用的部分

- 不把 Cairntir 的 SQLite memory 作为 KDock 会话权威存储；
- 不自动把任何外部历史提升为 Agent 指令；
- 不引入它的 21 个 MCP 工具作为 KDock 必需依赖；
- 不复制它的具体 taxonomy 和 API。

### 致谢候选名称

```text
Cairntir
https://github.com/pnmcguire480/cairntir
MIT License
Copyright (c) 2026 Patrick McGuire
```

## 5. ellmos-ai/usmc

| 项目 | 信息 |
| --- | --- |
| 仓库 | <https://github.com/ellmos-ai/usmc> |
| 名称 | USMC — United Shared Memory Client |
| 调研 commit | `b61342d16ab3242231eed48450e53082f2dc1812` |
| 许可证 | MIT |
| 版权声明 | Copyright (c) 2026 Lukas Geiger |
| 形态 | Python、SQLite、CLI、测试 |

### 可参考内容

USMC 用 SQLite 保存 facts、lessons、working notes 和 session handoffs，适合参考
“零常驻服务、本地优先”的工程取舍。

值得关注的设计：

- SQLite 事务和 WAL；
- 多进程并发时设置 busy timeout；
- session handoff 是结构化记录；
- agent identifier 只是数据标签，不是身份认证；
- 项目明确写明应用层仍需协调谁能访问数据库和如何执行工作流；
- 迁移前备份；
- 明确记录运行时依赖、网络能力和安全边界；
- 有 `NOTICE` 和第三方许可证清单。

其中最重要的一条对 KDock 是：

> SQLite 的锁只能协调数据库文件，不能代替会话执行锁。

因此 KDock 不会用“共享 SQLite 文件”或 agent id 字段来实现执行权。执行权必须由
Cloud Hub / LAN Hub 的 lease 和 fencing token 决定。

### 不直接采用的部分

- 不把 USMC 数据库当 KDock 的在线同步后端；
- 不依赖 Python 运行时；
- 不使用 agent label 代替设备认证；
- 不让 SQLite 文件出现在云盘同步目录中。

### 致谢候选名称

```text
USMC — United Shared Memory Client
https://github.com/ellmos-ai/usmc
MIT License
Copyright (c) 2026 Lukas Geiger
```

USMC 自身包含 `NOTICE`，如果后续复制其代码或数据文件，必须同时保留该声明。

## 6. LlamaIndex Discussion #20381

| 项目 | 信息 |
| --- | --- |
| 仓库 | <https://github.com/run-llama/llama_index> |
| 讨论 | <https://github.com/run-llama/llama_index/discussions/20381> |
| 标题 | Managing state across multi-step agent workflows in LlamaIndex — patterns? |
| 发言者 | `xXMrNidaXx`，提到 RevolutionAI 的实践 |
| 讨论日期 | 2026-02-23 |
| LlamaIndex 许可证 | MIT |
| 形态 | 社区讨论，不是 KDock 依赖，也没有可直接复制的实现 |

讨论中给出的四个状态管理方向：

1. 显式 typed state object；
2. event sourcing；
3. 分层 context；
4. 在成功步骤后序列化 checkpoint。

这与 KDock 的设计可以直接对应：

| 讨论中的模式 | KDock 对应 |
| --- | --- |
| typed state | `SessionMeta` / `SyncState` / `ContinuityCheckpoint` |
| event sourcing | 追加式会话事件流 |
| memory tiers | 最近消息 / 摘要 / 工作区上下文 |
| checkpoint | turn 边界、上下文压缩、释放租约前 |

### 不直接采用的部分

- 不引入 LlamaIndex workflow 依赖；
- 不把某一条社区回复当作正式规范；
- 不复制讨论中的示例代码。

### 致谢候选名称

```text
LlamaIndex Discussion #20381
https://github.com/run-llama/llama_index/discussions/20381
Community pattern discussion by xXMrNidaXx / RevolutionAI
LlamaIndex repository: MIT License
```

## 7. 建议纳入 KDock 的借鉴组合

| 借鉴点 | 来源 | 在 KDock 中的落点 |
| --- | --- | --- |
| `ACTIVE_GOAL` / `NEXT_EXECUTABLE_ACTION` | PPGP | `ContinuityCheckpoint` |
| 紧凑 handoff，不重放全文 | PPGP | 接管预览和上下文重建 |
| 独立版本化、可移植状态文件 | Agent Bud-E | 事件、manifest、blob |
| 多层 memory 与上下文预算 | Agent Bud-E | 摘要、近期消息、工作区上下文 |
| 原记录不可变、修正追加 | Cairntir | 追加式事件 |
| portable evidence / stable ID / hash | Cairntir | event_id、manifest_hash、blob hash |
| 导入内容默认不可信 | Cairntir | 新设备和副本权限隔离 |
| SQLite WAL / busy timeout | USMC | 本地 `sync.sqlite3` |
| label 不等于认证 | USMC | 设备身份和 lease 分离 |
| typed state + event sourcing + checkpoint | LlamaIndex 讨论 | 会话状态重建 |

## 8. 许可证处理结论

本次调研尚未复制任何项目代码、协议正文或数据文件。

当前处理：

1. 只在设计文档中记录名称、链接、commit、许可证和借鉴点；
2. 不把这些项目加入 KDock 的直接依赖；
3. 不把其源码打包进 KDock；
4. 不复制其测试、图片、数据或文档段落。

如果后续实际复制或修改代码：

- MIT 项目：保留原版权声明和 MIT 许可证文本；
- Apache-2.0 项目：保留 LICENSE、NOTICE（如有）和修改说明；
- 在根目录 `NOTICE` 中增加“参考/移植/打包”边界；
- 在发布包中提供对应许可证副本；
- 对仅参考交互和架构、未复制代码的项目，也建议在 README 或 NOTICE 中致谢。

## 9. 命名建议

不建议把 KDock 的同步功能直接命名为 PPGP、Cairntir、USMC 或 Agent Bud-E 的衍生名称。

建议使用 KDock 自己的产品名称，例如：

- KDock Session Sync；
- KDock Continuity；
- KDock Session Link。

最终名称应在协议、UI、许可证和发布说明中保持一致。
