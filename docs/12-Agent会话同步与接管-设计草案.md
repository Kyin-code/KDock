# Agent 会话同步与接管设计草案

> 状态：**方案草案 v0.2，关键范围已确认，未实现**
>
> 本文用于确认会话同步、工作区链接和执行权租约的边界，不代表已经进入实现阶段。
> 剩余待确认项见第 15 节。

## 1. 目标

让同一个 Agent 会话可以在多台安装了 KDock 的设备之间同步，并允许其中一台设备在
会话空闲时申请执行权。

需要实现：

1. 同步会话消息、工具调用、工具结果和可重建的模型上下文；
2. 用户显式确认链接的工作区可以跨设备同步；
3. 同一时刻只允许一个 KDock 执行 LLM 请求和工具调用；
4. 执行设备每 5 秒向权威端汇报状态；
5. 其他设备以只读副本运行，只同步消息、上下文和工作区，不直接调用 LLM；
6. 同时支持云端权威端和局域网权威端；
7. 执行设备失联后，可以在租约过期后由另一台设备接管。

## 2. 非目标

首版明确不做：

- 多人同时编辑同一个会话；
- 多台设备同时调用 LLM；
- CRDT 文本合并；
- 自动合并两个不同版本的工作区；
- 自动同步所有工作区；
- NAS、WebDAV、SMB、NFS 等共享存储方案；
- 服务端代调用 LLM；
- 迁移模型厂商的 KV Cache 或隐藏推理状态；
- 云端与局域网自动切换权威端。

### 2.1 关于“完整上下文”

可以同步并重建：

- 用户消息；
- Agent 可见回复；
- 工具调用和结果；
- 上下文摘要；
- 系统提示快照；
- 工具 schema 快照；
- 模型、思考强度和 provider 配置；
- 工作区 revision。

不能保证同步：

- 模型厂商内部的 KV Cache；
- 隐藏推理状态；
- 正在生成的 LLM 流；
- 当前机器上的串口、USB、驱动和网络状态；
- 正在执行的工具进程；
- 本机 API Key。

因此跨设备接管表达为“基于共同事件和摘要重建上下文，然后开始新的 turn”，
而不是“无损迁移一个正在生成的模型请求”。

## 3. 核心决策

### D1：保持单仓库

不拆成新的独立仓库。同步能力作为 KDock 的一个子系统，放在现有 Cargo workspace 内。

建议的代码边界：

```text
KDock/
├─ crates/
│  ├─ kdock-core/             现有核心库
│  ├─ kdock-sync/             同步协议、租约、事件信封、加密
│  └─ kdock-sync-hub/         云端/LAN 权威端，可作为独立二进制
├─ src-tauri/
│  └─ src/sync/               Tauri 客户端集成、transport、本地缓存
└─ src/
   └─ agent-sync.js           会话所有权、工作区链接和接管 UI
```

`kdock-sync-hub` 是一个可独立部署的二进制，但不是独立仓库，也不是独立产品。

### D2：每个会话只有一个逻辑权威端

同一会话只能属于一个权威端：

- Cloud Hub；
- LAN Hub。

云端和局域网使用同一套协议、同一套状态机，只是部署方式和存储后端不同。
禁止同一个会话同时在云端和 LAN 写入。

### D2.1：默认局域网，MAIN 由用户指定

首版默认使用局域网同步，不要求用户先拥有公网服务器。

局域网中由用户明确选择一台设备作为 `MAIN`：

- `MAIN` 运行 LAN Hub 和租约权威端；
- `MAIN` 负责事件顺序、租约、成员资格和能力清单校验；
- `MAIN` 可以由当前执行设备兼任，也可以由另一台不执行 Agent 的设备担任；
- 其他设备通过 mDNS 发现并连接到 `MAIN`；
- `MAIN` 不要求固定公网 IP；
- `MAIN` 下线后不自动选举新的 `MAIN`；
- 其他设备可以继续查看已同步内容，但不能新抢锁，直到原 `MAIN` 恢复或用户显式指定新 `MAIN`。

不自动选举的原因是要避免网络分区后出现两个 `MAIN`，进而造成双写和重复工具执行。

如果用户提供自己的服务器，则允许把 Cloud Hub 作为权威端。服务器可以是用户自己的
云主机、公司服务器或局域网内的常驻服务器。

### D2.2：提供同步服务安装命令

LAN 模式优先支持在某台 KDock 中内嵌启动 Hub，无需额外安装。

对于无人值守设备或用户自己的服务器，提供一个与客户端同仓库构建的
`kdock-sync-hub` 二进制，并支持类似 npm 的安装/更新体验。

候选命令，最终名称待定：

```text
kdock sync-hub install --mode lan
kdock sync-hub install --mode server
kdock sync-hub start
kdock sync-hub status
kdock sync-hub update
kdock sync-hub uninstall
```

安装器只从 KDock 官方 GitHub Release 下载 Hub 资产，并校验签名或 SHA-256。
不执行任意第三方 npm 包，也不允许用户填入未经校验的下载地址。

### D3：单写者

同一会话在同一时刻只有一个执行设备。其他设备进入只读副本模式。

执行权不能只靠 UI 状态表示，必须在 Rust 后端和权威端同时校验。

### D4：会话锁与工作区锁绑定

一次执行需要同时取得：

```text
session_lease
+ workspace_lease(workspace_link_id[])
```

只取得会话锁但未取得工作区锁，不允许开始执行。

这样可以防止两个不同会话同时写同一个链接工作区。

一个工作区允许被多个会话引用，但工作区写锁仍然必须互斥。工作区空闲时可以绑定到
任意一个会话，工作区正在执行时其他会话只能只读。

### D5：工作区必须由用户显式链接

不是 KDock 中的每个工作区都会同步。

只有满足以下条件的目录参与同步：

1. 用户明确创建或接受工作区链接；
2. 本地选择一个父目录；
3. 最终挂载目录的最后一级名称与链接定义一致；
4. 目标目录为空，或者内容指纹与同一工作区一致。

`leaf_name` 是挂载约束，不是工作区身份。真正身份是 `workspace_id`。

### D6：首版按单工作区会话设计

当前 `SessionMeta` 只有一个工作区路径。首版可以让一个会话只绑定一个主工作区。

协议层保留 `workspace_link_ids[]`，以后可以扩展到多工作区；首版不把这个扩展
复杂度带进执行锁和 UI。

### D7：首版使用简单加密

首版不做复杂的设备密钥轮换和多级密钥体系，但不能使用自制加密算法。

建议定义为：

- 传输层强制 WSS/HTTPS；
- 消息事件和工作区 Blob 使用会话内容密钥进行认证加密；
- 使用成熟实现，例如 AES-256-GCM 或 XChaCha20-Poly1305；
- 会话内容密钥通过配对码或二维码交付；
- 每台设备用 Windows DPAPI 或系统凭据存储保护本地密钥；
- 云端保存密文事件和工作区 Blob；
- LLM API Key 永远不进入同步数据；
- 首版暂不做复杂的设备密钥轮换、密钥恢复和群组密钥管理。

服务器仍然能看到必要的控制元数据，例如会话 ID、设备 ID、序号、租约状态和大小。

即使使用用户自己的服务器，也建议保持这一边界，避免服务端默认读取 Agent 内容。

### D8：SKILL 和 MCP 必须多机一致

同步会话中使用的 SKILL 和 MCP 必须满足：

1. 所有当前成员设备都已经安装；
2. ID、版本和内容 hash 一致；
3. MCP 健康检查通过；
4. 工具 schema 一致；
5. 设备已明确允许该能力参与远程会话。

只有满足以上条件的公共能力才能进入同步会话的有效工具集。

设备本地独有的 SKILL/MCP 不能用于可接管的同步会话。需要使用时，应让其他设备先安装，
或者把这个会话改为不支持多机接管的本地会话。

MCP 的 API Key、Token、机器路径和本机硬件依赖不参与同步。同步的是能力声明和配置模板，
真实凭据由每台设备自己配置。

新增第三台设备时：

```text
JOIN_PENDING
  -> 同步能力清单
  -> 安装/校验 SKILL 和 MCP
  -> 校验工具 schema
  -> 同步会话和工作区
  -> READY
```

在进入 `READY` 前，新设备不能持有租约，也不能被算作有效执行成员。

### D9：首版不迁移模型内部状态

同步的是事件、上下文清单和工作区，不尝试复制模型厂商的 KV Cache、隐藏思考状态或
正在生成的推理流。接管后从共同事件和摘要重建上下文，再开始新的 turn。

## 4. Cloud 与 LAN 的区别

| 项目 | 云端模式 | 局域网模式 |
| --- | --- | --- |
| 权威端 | Cloud Hub | LAN Hub |
| 发现方式 | 配置 URL | mDNS |
| 鉴权 | 账号/设备令牌 | 配对码 + 固定设备公钥 |
| 传输 | WSS + HTTPS | WSS + HTTPS |
| 存储 | PostgreSQL + 对象存储 | SQLite + 本地 Blob 目录 |
| TLS | 公网证书 | 自签名证书 + 指纹固定 |
| 可用性 | 随时在线 | 同一局域网内 |
| 协议 | 相同 | 相同 |
| 租约语义 | 相同 | 相同 |

实现上不建议写两套业务逻辑。应通过配置区分：

```text
HubMode = Cloud | Lan
StorageBackend = Postgres | SQLite
BlobBackend = ObjectStore | LocalDirectory
Discovery = StaticUrl | Mdns
```

局域网模式下，用户选择的 `MAIN` 就是 `HubMode = Lan` 的权威设备。
云服务器模式则由用户配置自己的服务器地址，使用 `HubMode = Cloud`。

## 5. 会话同步模型

### 5.1 事件信封

现有会话使用追加式 JSONL，这是合适的同步基础。同步层不直接复制 JSONL 文件，
而是在事件外增加同步信封：

```text
session_id
event_id
session_seq
device_id
lease_id
fencing_token
payload_hash
ciphertext
created_at
```

权威端分配 `session_seq`，保证所有设备看到同一个顺序。

### 5.2 会话内事件

首版同步以下事件：

- User；
- Assistant；
- ToolCall；
- ToolResult；
- Summary；
- Note；
- State。

流式 token 不作为事件逐字同步。心跳只报告“正在生成”，完整 Assistant 内容在
消息边界提交。这样能避免产生巨量同步事件。

### 5.3 上下文清单

除事件流外，还需要同步一份上下文清单：

```text
provider
model
reasoning_effort
system_prompt_hash
skill_manifest_hash
mcp_manifest_hash
capability_epoch
tool_schema_hash
tool_epoch
summary_version
workspace_revision
```

接管设备重建上下文前先校验清单。

如果版本不一致：

- 不自动假装上下文完全一致；
- 提示用户“上下文配置已变化”；
- 允许重新生成系统提示或从摘要继续；
- 必要时阻止接管，要求先解析冲突。

### 5.4 SKILL 和 MCP 能力清单

每台设备需要上报一份能力清单：

```text
device_id
capability_epoch
skills[]
  id
  version
  content_hash
  enabled
mcp_servers[]
  id
  version
  transport
  tool_schema_hash
  health
capability_hash
```

约束：

- 会话第一次开始执行时，固定一份 `required_capabilities`；
- 所有有效成员必须具备相同的 SKILL/MCP 集合；
- MCP 必须在本机健康检查通过，不能只根据配置文件存在判断；
- 工具 schema 必须一致；
- 设备本地特有、但其他设备没有的能力不进入同步会话；
- MCP 凭据、Token、本机路径和硬件依赖不上传；
- 新增成员在能力齐套前不能取得执行权。

如果用户需要新增一个 SKILL 或 MCP：

1. 所有有效成员先安装并校验；
2. 提升 `capability_epoch`；
3. 重建工具 schema 和系统提示；
4. 明确这是一次缓存失效；
5. 再允许下一轮执行。

在当前会话中，不允许某个设备使用只有自己安装的私有能力后把结果交给其他设备接管。
这会破坏上下文可重建性。

### 5.5 本地事件与云端事件

执行设备本地仍可保留现有 JSONL，作为 UI 的本地投影。

权威端保存已提交的事件序列。建议：

1. 本地事件先进入 outbox；
2. 带 `lease_id + fencing_token` 提交给权威端；
3. 权威端返回 `session_seq`；
4. 本地标记为已提交；
5. 其他设备按 `after_seq` 拉取；
6. 收到后写入本地 JSONL，并在同步数据库中登记 event_id 去重。

租约失效后，未提交的本地事件不能使用旧 fence 强行上传。

### 5.6 ContinuityCheckpoint

事件流适合完整恢复，但接管时不应每次都重放全部历史。可在关键边界生成一份
紧凑的 `ContinuityCheckpoint`：

```text
goal
verified_current_state
completed
remaining
blockers
verification_evidence
next_executable_action
capability_epoch
workspace_revision
up_to_event_seq
```

生成时机：

- 一轮任务完成；
- 上下文压缩前；
- 执行设备准备释放租约；
- 新设备接管前；
- 用户主动生成 handoff。

`ContinuityCheckpoint` 是派生状态，不是新的权威历史。它必须指向
`up_to_event_seq`，并保留与事件流、工作区 revision 的对应关系。

## 6. 执行权租约

### 6.1 状态机

```text
IDLE
  │ claim
  ▼
RUNNING
  │ 正常结束
  ├──────────────► IDLE
  │
  │ 主动释放
  ▼
DRAINING
  │ 工具停止、事件提交、工作区同步
  └──────────────► IDLE

RUNNING
  │ 心跳超时/程序崩溃
  ▼
ORPHANED
  │ 租约过期 + 安全确认
  └──────────────► IDLE
```

`WAITING` 可以视为 `RUNNING` 的子状态，用于等待审批或长时间工具执行。

### 6.2 租约字段

```text
session_id
owner_device_id
lease_id
fencing_token
expires_at
runtime_state
last_heartbeat_at
active_turn_id
active_tool_call_id
last_event_seq
workspace_revisions
unsynced_bytes
```

### 6.3 抢占条件

抢占事务必须原子完成，并检查：

- 会话状态为 `IDLE`；
- 当前租约不存在或已过期；
- 没有活动 turn；
- 没有待审批工具；
- 没有子 Agent 运行；
- 所有需要的工作区都处于可用且已同步状态；
- 所有工作区锁都可取得；
- 当前设备成员状态为 `READY`；
- 当前设备能力清单与会话要求一致；
- 所需 MCP 健康检查通过。

成功抢占后：

```text
fencing_token += 1
lease_id = 新 ID
owner = 当前设备
expires_at = 当前时间 + TTL
```

### 6.4 心跳

建议参数：

```text
心跳间隔：5 秒
租约 TTL：20 秒
连续 2 次失败：进入准备停止状态
TTL 到期：权威端撤销租约
```

心跳不是会话历史，不写入事件流。权威端只保存当前控制状态和短期诊断记录。

客户端使用服务端返回的时间或基于 ACK 的单调计时，不能只依赖设备本地墙钟。

### 6.5 fencing

所有写操作都必须验证：

```text
lease_id
fencing_token
```

旧设备恢复网络后，即使还能访问权威端，它的旧 fence 也必须被拒绝：

- 不能追加事件；
- 不能更新工作区 revision；
- 不能审批工具；
- 不能启动子 Agent；
- 不能继续 LLM 请求。

### 6.6 进程树和副作用

这是租约正确性的一部分，不只是进程管理问题。

要求：

- 所有工具子进程进入 Windows Job Object；
- 设置 `KILL_ON_JOB_CLOSE`；
- KDock 退出、崩溃或失去租约时，关闭对应 Job Object；
- 烧录、串口发送、文件写入等操作带 `operation_id`；
- 无法确认工具已经停止时，会话保持 `ORPHANED` 或 `DRAINING`；
- 强制接管时，对高风险操作增加二次确认。

现有 `src-tauri/src/agent/sandbox.rs` 已经使用 AppContainer 和 Job Object，
后续应在租约丢失时复用并强化这一层。

## 7. 工作区链接与同步

### 7.1 数据模型

共享工作区：

```text
workspace_link_id
workspace_id
display_name
leaf_name
created_by
current_revision
manifest_hash
```

设备本地绑定：

```text
device_id
workspace_link_id
parent_path
resolved_path
mount_state
last_synced_revision
```

例如：

```text
设备 A：D:\Projects\Alpha\firmware
设备 B：C:\Work\firmware
```

完整路径不同，但最后一级 `firmware` 必须相同。

### 7.2 链接流程

1. 设备 A 的用户选择一个工作区；
2. KDock 生成 `workspace_id` 和链接邀请；
3. 设备 B 的用户接受邀请；
4. 设备 B 选择父目录；
5. KDock 生成 `<父目录>/<leaf_name>`；
6. 若目标已存在且内容指纹不一致，拒绝自动合并；
7. 同步初始 manifest 和内容；
8. 校验完成后进入 `READ_ONLY`。

不能因为两个设备都有一个同名目录就自动建立链接。

### 7.3 manifest

```text
workspace_revision
  revision
  manifest_hash
  files[]
  deleted[]
  relative_path
  file_hash
  blob_refs[]
```

原则：

- 所有路径都是工作区相对路径；
- 默认排除 `.git`、构建产物、缓存和密钥；
- 删除使用 tombstone；
- 不递归删除未由 KDock 管理的文件；
- 禁止路径穿越；
- 禁止符号链接或目录联接逃逸工作区根目录；
- 副本校验 hash 后才标记为可用。

### 7.4 只读副本

副本默认只读，并显示：

```text
READ_ONLY
SYNCING
WRITABLE
DIVERGED
MISSING
```

只读限制要做在：

- Tauri command；
- Agent 工具；
- UI 操作；
- 本地文件监听。

普通目录的只读属性不是可靠安全边界。外部编辑器仍可能修改文件，因此需要记录
外部改动并在接管前重新校验。

如果副本需要编译，构建输出应放在每台设备独立的构建目录，不进入共享工作区。

### 7.5 接管前置检查

新设备申请执行权前必须确认：

- 会话要求的 `workspace_link_id` 已绑定；
- 本地挂载目录存在；
- 最后一级目录名匹配；
- 当前 revision 已同步完成；
- 本地没有未处理的外部修改；
- 工作区锁可以取得。

任一条件不满足，只能保持只读，不能接管。

## 8. 只读副本行为

副本可以：

- 查看已提交消息；
- 查看工具调用摘要和结果；
- 查看上下文状态；
- 查看已同步工作区；
- 申请停止；
- 申请接管。

副本不能：

- 调用 LLM；
- 调用工具；
- 修改工作区；
- 审批工具；
- 启动子 Agent；
- 追加会话事件。

这些限制必须在 Rust 后端拒绝，不能只依赖禁用按钮。

## 9. UI 草案

### 9.0 MAIN 与同步方式

首次建立局域网会话时：

1. KDock 通过 mDNS 展示可发现的设备；
2. 用户明确选择一台作为 `MAIN`；
3. 其他设备输入或扫描配对码加入；
4. 设备显示 MAIN 名称、IP 和在线状态；
5. 不允许 KDock 自动替用户选择 MAIN。

用户也可以选择“使用自己的服务器”，填写：

- 服务器地址；
- 设备令牌；
- 会话是否在服务器上持久化。

同步设置页需要显示：

```text
同步方式：局域网 / 用户服务器
MAIN：DESKTOP-A
状态：在线 / 不可达
角色：执行设备 / 只读副本 / JOIN_PENDING
```

### 9.1 会话顶部状态

建议显示：

```text
本机执行中 · 2 秒前心跳
只读同步 · 由 DESKTOP-A 执行
只读同步 · 权威端离线
正在接管 · 等待当前工具停止
离线 · 无法取得会话锁
能力未对齐 · 缺少 2 个 SKILL / 1 个 MCP
```

### 9.2 工作区链接

工作区设置页需要展示：

- 已链接/未链接；
- 本地实际挂载路径；
- 最后一级目录名；
- 当前 revision；
- 同步状态；
- 最近同步时间；
- 解除链接；
- 重新绑定父目录。

### 9.3 接管

只有会话空闲时才显示“接管”按钮。

执行中时只能：

- 申请停止；
- 查看当前执行设备；
- 查看心跳状态。

接管前提供预检结果，明确哪些工作区未同步或存在本地修改。

### 9.4 能力同步

设备加入会话后先进入 `JOIN_PENDING`，显示：

- 缺少的 SKILL；
- 缺少的 MCP；
- 版本或 hash 不一致项；
- MCP 健康检查失败项；
- “安装/校验”按钮；
- 对齐完成后的 `READY` 状态。

未进入 `READY` 的设备不能显示可用的“接管”按钮。

## 10. 协议草案

控制通道建议使用 WSS，大文件使用 HTTPS 分片传输。

核心消息：

```text
Hello
MainDiscover
MainSelect       { device_id }
MemberJoin       { session_id, device_id }
CapabilityReport { capability_manifest }
CapabilityReady  { capability_hash }
CheckpointPublish { up_to_event_seq, checkpoint }
CheckpointGet     { after_seq }
SessionSubscribe { after_seq }
EventPull       { after_seq }
EventAppend     { lease_id, fence, event }
LeaseClaim      { session_id, workspace_links[] }
LeaseGranted    { lease_id, fence, expires_at }
Heartbeat       { lease_id, fence, runtime_state }
HeartbeatAck    { server_time, expires_at }
LeaseRelease
WorkspaceManifestGet
WorkspaceManifestPublish
TakeoverRequest
TakeoverReady
TakeoverRejected
```

云端和 LAN Hub 使用同一套消息。不同点只在 discovery、认证、存储和 TLS。

局域网模式下 `MAIN` 负责创建会话并持有权威状态。服务器模式下由 Cloud Hub 承担
相同角色。

## 11. 安全与隐私

建议默认：

- 会话事件和工作区 Blob 端到端加密；
- 每个会话使用独立内容密钥；
- 新设备通过配对码或二维码获得内容密钥；
- 内容密钥由 Windows DPAPI 或系统凭据存储保护；
- 云端不知道 LLM API Key；
- 云端不保存本地绝对路径；
- 用户可以按会话关闭同步；
- 用户可以排除敏感文件；
- SDK/Token/私钥默认不进入工作区同步。

LAN 模式使用设备公钥固定的 TLS，不仅依赖同一 Wi-Fi 来判断信任。

首版移除设备时只撤销该设备的访问令牌。旧设备已经收到的历史数据无法被远程追回，
UI 必须明确提示；完整的密钥轮换和设备吊销留到后续版本。

## 12. 失败场景

| 场景 | 处理 |
| --- | --- |
| 心跳丢失 10 秒 | 停止发起新请求，UI 显示连接不稳定 |
| 租约到期 | 执行端停止工具，权威端标记 `ORPHANED` |
| 执行端崩溃 | Job Object 回收子进程，租约过期后可接管 |
| 旧设备恢复网络 | 旧 fence 的写入全部拒绝 |
| 两台设备同时抢锁 | 权威端事务保证只有一个成功 |
| 云 LAN 同时在线 | 禁止自动切换，保持单一权威端 |
| MAIN 离线 | 现有副本只读，不自动选举新 MAIN |
| 新设备能力未对齐 | 保持 `JOIN_PENDING`，不能接管 |
| SKILL/MCP hash 不一致 | 禁止进入同步执行会话 |
| MCP 健康检查失败 | 该设备不能成为有效执行成员 |
| 工作区未同步完 | 保持只读，不允许接管 |
| 工作区本地被外部修改 | 标记 `DIVERGED`，阻止自动覆盖 |
| 事件重复上传 | 按 `event_id` 和 `session_seq` 幂等去重 |

## 13. 分阶段计划

### M1：协议与租约内核

- 新建 `crates/kdock-sync`；
- 定义事件信封、lease、fence 和状态机；
- 用模拟时钟和模拟网络做单元测试；
- 不接入 UI。

验收：两个模拟设备同时抢占，永远只有一个成功。

### M2：LAN Hub 与只读副本

- LAN Hub 实现租约和事件接口；
- 用户选择 MAIN；
- KDock 接入 WSS；
- 执行设备 5 秒心跳；
- 其他设备只读同步；
- 失联后租约过期；
- 接入 `agent_send` 和写工具的统一执行守卫。

验收：A 执行时 B 无法发送或调用工具；A 失联后 B 可在 TTL 后接管；
MAIN 离线时其他设备不会自动产生第二个 MAIN。

### M3：用户确认的工作区链接

- 工作区邀请和绑定；
- 最后一级名称校验；
- manifest/blob 同步；
- 只读镜像；
- 工作区锁；
- 一个工作区可被多个会话引用，但同时只有一个写者；
- 接管前 revision 校验。

验收：A、B 使用不同父目录但相同最后一级；B 只读；内容不一致时拒绝合并。

### M4：用户服务器与 Cloud Hub

- 复用 Cloud Hub 协议；
- 支持用户自己的服务器 URL 和设备令牌；
- 提供 `kdock-sync-hub install/update/status/uninstall`；
- 从官方 GitHub Release 下载并校验；
- PostgreSQL 和对象存储作为生产后端；
- 允许不依赖 KDock 官方云运行。

验收：用户自己的服务器可以承担与 LAN MAIN 相同的租约和同步职责。

### M5：接管体验和故障恢复

- 所有权状态条；
- MAIN 选择与离线状态；
- SKILL/MCP 能力对齐；
- 心跳倒计时；
- 申请停止；
- 接管预检；
- `DRAINING/ORPHANED` 处理；
- 失联提示；
- 冲突和强制恢复。

## 14. 必须覆盖的测试

1. 双设备同时抢占；
2. 心跳抖动和短暂断网；
3. 执行中崩溃；
4. 旧 fence 延迟写入被拒绝；
5. 事件重复提交幂等；
6. 只读副本发送消息被拒绝；
7. 只读副本调用工具被拒绝；
8. 工作区最后一级名称不一致；
9. 未链接工作区时不能接管；
10. 工作区同步未完成时不能接管；
11. 外部修改工作区后标记 `DIVERGED`；
12. 删除路径不能越出工作区根目录；
13. 云端和 LAN 不能同时成为同一会话的权威端；
14. 进程树在失联和崩溃后确实终止；
15. MAIN 离线后不能自动产生第二个 MAIN；
16. 第三台设备缺少 SKILL/MCP 时不能进入 `READY`；
17. SKILL/MCP hash 不一致时不能接管；
18. 一个工作区被两个会话引用时只能有一个写者。

前端交互可以通过 Vite 开发服务器配合 mock Hub 验证；真实租约和进程清理必须用
Tauri/Rust 集成测试验证。

## 15. 待确认问题

已确认：

1. 默认使用局域网，由用户选择一台设备作为 MAIN；
2. 允许使用用户自己的服务器；
3. 首版每个会话只支持一个主工作区；
4. 首版使用简单加密；
5. SKILL 和 MCP 必须所有有效设备一致，新设备先同步能力；
6. 一个工作区允许被多个会话引用，但写锁必须互斥。

仍需确认：

1. 最终命令名是 `kdock sync-hub ...` 还是独立 `kdock-sync-hub ...`；
2. 用户服务器模式是否也提供 Docker Compose 安装方式；
3. 云端账号体系是否复用 KDock 现有服务，还是只使用设备令牌；
4. 工作区同步是否默认排除 `.git`，还是允许用户选择完整目录；
5. 副本是否需要真正的系统级只读挂载，还是首版只做 KDock 内只读镜像；
6. `leaf_name` 是否允许重命名，还是必须解除链接后重新建立；
7. 强制接管高风险工具前，是否要求输入设备名或二次确认；
8. MAIN 的显式迁移是否需要“原 MAIN 在线确认”，还是允许离线强制迁移；
9. SKILL/MCP 能力升级时，是否必须新建会话，还是允许会话内提升 capability epoch。

建议首版取值：

| 问题 | 建议首版 |
| --- | --- |
| Hub 命令 | 客户端内用 `kdock sync-hub`；服务器/无人值守用独立 `kdock-sync-hub` |
| 用户服务器安装 | 提供 Docker Compose，也保留原生二进制 |
| 服务器鉴权 | 设备令牌，不强制账号登录 |
| `.git` | 默认排除，允许用户显式选择包含 Git 元数据 |
| 只读副本 | 首版做 KDock 管理的只读镜像，不做系统级挂载 |
| `leaf_name` | 创建后不可变，改名必须解除并重新链接 |
| 高风险接管 | 必须二次确认，并显示原执行设备与最后心跳 |
| MAIN 迁移 | 用户显式确认；允许离线强制迁移，但产生新 fence 并记录审计事件 |
| SKILL/MCP 升级 | 首版新建会话；后续再做 capability epoch 热升级 |

## 16. 建议的首版范围

建议第一版只做：

- 单仓库，新增同步 crate 和 Hub 二进制；
- 先 LAN Hub，后用户服务器/Cloud Hub；
- 默认局域网，MAIN 由用户选择；
- 每个会话单主工作区；
- 工作区可被多个会话引用，但只能有一个写锁持有者；
- 简单加密：TLS + 会话内容密钥 + 系统凭据保护；
- SKILL/MCP 能力清单校验；
- 只读副本；
- 会话锁 + 工作区锁；
- 5 秒心跳、20 秒 TTL；
- 崩溃/失联后的 `ORPHANED` 和人工确认接管；
- 明确禁止云端/LAN 自动双写。

暂不实现：

- 多人实时协作编辑；
- 多工作区；
- CRDT；
- 无中心 P2P；
- 自动云 LAN 迁移；
- 自动 MAIN 选举；
- 复杂密钥轮换和恢复；
- 服务端 LLM 代理。

## 17. 参考项目

参考项目、调研 commit、许可证和致谢候选名称见：

- [`13-Agent会话同步-参考项目与许可证调研.md`](./13-Agent会话同步-参考项目与许可证调研.md)

目前只参考架构和工程取舍，没有复制代码。如果后续采用任何代码、协议正文或数据文件，
必须更新根目录 `NOTICE`。

主要参考：

- `Fatboy-coder/ppgp` — MIT；
- `LAION-AI/agent-bud-e` — Apache-2.0；
- `pnmcguire480/cairntir` — MIT；
- `ellmos-ai/usmc` — MIT；
- `run-llama/llama_index` Discussion #20381 — MIT 仓库中的社区讨论。

## 18. 结论

这个方案在单仓库内可以实现，关键是把复杂度控制在：

```text
追加式事件同步
+ 单写者租约
+ fencing token
+ 显式工作区链接
+ 只读副本
+ 进程树安全停止
```

它解决的是“会话接管”和“受控工作区同步”，不是“多人同时编辑”。

第 15 节剩余问题确认前，不建议开始实现租约和云端协议；可以先做不影响架构的
准备工作，例如事件信封格式、能力清单格式、工作区 manifest 格式和本地只读副本原型。
