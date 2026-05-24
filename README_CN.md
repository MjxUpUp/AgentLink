# AgentLink

AI 编程智能体的 P2P 通信层。通过加密通道连接局域网内的 AI 智能体，借助 mDNS 自动发现对等节点，并通过模型上下文协议（MCP）委派任务。

## 特性

- **加密 P2P 传输** — 基于 TCP 的连接，使用 libsodium 的 XChaCha20-Poly1305 secretstream 加密和 Ed25519 密钥交换
- **零配置发现** — mDNS 广播/监听，自动检测局域网对等节点，支持静态节点回退
- **任务委派** — 完整的任务生命周期（创建 → 接受 → 进度 → 完成/失败），支持优先级、超时和产物附件
- **信任管理** — 显式信任模型，支持已知智能体自动审批、团队种子导入/导出
- **MCP 集成** — 将所有能力暴露为 MCP 工具、资源和提示——开箱即用，兼容任何支持 MCP 的 AI 智能体
- **审计日志** — 每条入站/出站事件以 JSONL 格式记录，支持全链路追踪
- **网络韧性** — 指数退避自动重连、DHCP 自适应、地址簿跟踪

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    AI 智能体 (MCP Host)                  │
│                  Claude / Cursor / ...                   │
└──────────────────────┬──────────────────────────────────┘
                       │ stdio (MCP)
┌──────────────────────▼──────────────────────────────────┐
│                  AgentLink MCP 服务器                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │   工具   │ │   资源   │ │   提示   │ │  信任管理  │ │
│  └────┬─────┘ └──────────┘ └──────────┘ └────────────┘ │
│       │         任务管理器      审计日志                  │
├───────┼─────────────────────────────────────────────────┤
│       │              传输层 (TCP)                        │
│       │         ┌──────────────────────┐                │
│       │         │ XChaCha20-Poly1305   │                │
│       │         │ Ed25519 密钥交换     │                │
│       │         └──────────────────────┘                │
├───────┼─────────────────────────────────────────────────┤
│       │           发现层 (mDNS)                          │
│       │    地址簿        智能体数据库 (SQLite)            │
└───────┴─────────────────────────────────────────────────┘
                       │ TCP / mDNS
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       智能体 A     智能体 B     智能体 C
```

## 快速开始

### 方式一：一键安装（Claude Desktop）

下载 [agentlink.mcpb](https://github.com/user/agentlink/releases) → 双击安装 → 完成。

首次启动会自动使用默认配置初始化。

### 方式二：命令行安装

```bash
npx @agentlink/server serve
```

首次运行会引导你完成设置，无需单独执行 init 命令。

### 适用于其他 MCP 宿主（Cursor、VS Code 等）

添加到 MCP 宿主配置中：

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "npx",
      "args": ["-y", "@agentlink/server", "serve"]
    }
  }
}
```

### 手动初始化（可选）

```bash
npx agentlink init --name "My Agent" --type "coder" --capabilities "code-review,testing"
```

## 命令行

```
agentlink init              初始化身份和配置
agentlink serve             启动 MCP 服务器（含 P2P 传输和节点发现）
agentlink status            显示智能体状态、信任列表和活跃任务
agentlink trust list        列出受信任的智能体
agentlink trust remove <id> 移除受信任的智能体
```

### Init 选项

```
--name <name>              智能体显示名称
--type <type>              智能体类型（如 coder、reviewer）
--capabilities <caps>      逗号分隔的能力列表
```

## MCP 工具

| 工具 | 描述 |
|------|------|
| `agentlink_discover` | 发现局域网智能体。可按能力或状态过滤。 |
| `agentlink_send_message` | 向指定智能体发送消息/任务。 |
| `agentlink_broadcast` | 向所有受信任的在线智能体广播消息。 |
| `agentlink_get_status` | 获取指定智能体的详细信息。 |
| `agentlink_wait_for_reply` | 阻塞等待任务回复，直到收到回复或超时。 |

### MCP 资源

| URI | 描述 |
|-----|------|
| `agentlink://agents` | 当前在线的智能体 |
| `agentlink://tasks` | 活跃（未终结）的任务 |
| `agentlink://trust` | 受信任的智能体及其信任级别 |

## 安全模型

- **Ed25519 身份** — 每个智能体在初始化时生成密钥对。智能体 ID 从公钥派生（`al-XXXXXXXX-XXXXXXXX-XXXXXXXX`）。
- **加密传输** — 所有 TCP 流量使用 XChaCha20-Poly1305 secretstream，会话密钥通过 `crypto_kx` 派生。
- **签名消息** — 每条消息使用发送者的 Ed25519 私钥签名，接收方验证签名。
- **基于信任的访问控制** — 智能体默认不受信任。需要显式信任授权才能进行任务委派和广播。
- **团队种子** — 支持导出/导入信任列表，用于预配置团队。

## 配置

配置存储在 `~/.agentlink/config.json`：

```json
{
  "identity": {
    "name": "My Agent",
    "agentType": "coder",
    "capabilities": ["code-review", "testing"]
  },
  "network": {
    "port": 9876,
    "mdns": true,
    "bindAllInterfaces": true,
    "excludeInterfaces": ["docker0", "veth*", "lo"],
    "peers": []
  },
  "security": {
    "requireApproval": "untrusted",
    "autoApproveTrusted": true,
    "maxConcurrentTasks": 3
  },
  "logging": {
    "level": "info",
    "auditLog": true
  }
}
```

## 项目结构

```
src/
├── cli/               # 命令行入口 (commander)
│   ├── index.ts
│   └── actions.ts
├── core/
│   ├── identity.ts    # Ed25519 密钥生成、签名、验签
│   ├── transport.ts   # TCP 传输层（secretstream 加密）
│   ├── discovery.ts   # mDNS 广播/监听 + 静态节点
│   ├── task-manager.ts # 任务生命周期（SQLite 持久化）
│   ├── trust-manager.ts # 信任存储（团队种子导入/导出）
│   ├── audit-logger.ts  # JSONL 审计日志
│   ├── address-book.ts  # 对等节点地址跟踪
│   └── types.ts       # 共享类型和常量
├── db/
│   └── database.ts    # SQLite 模式和查询
├── mcp/
│   ├── server.ts      # AgentLinkServer — 组装所有模块
│   └── tools.ts       # MCP 工具、资源和提示
└── index.ts           # 公共 API 导出
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 运行测试
npm test

# 类型检查
npm run lint
```

## 技术栈

- **运行时：** Node.js (TypeScript, ESM)
- **传输：** 原生 TCP，长度帧消息
- **加密：** libsodium（Ed25519 签名、X25519 密钥交换、XChaCha20-Poly1305 加密）
- **发现：** bonjour-service (mDNS/DNS-SD)
- **数据库：** better-sqlite3 (WAL 模式)
- **MCP：** @modelcontextprotocol/sdk
- **CLI：** commander
- **测试：** vitest

## 许可证

MIT
