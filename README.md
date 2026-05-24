<div align="center">

# AgentLink

**P2P communication layer for AI agents**

Connect AI agents on your local network via encrypted channels, discover peers through mDNS, and delegate tasks — all through the Model Context Protocol (MCP).

[![npm version](https://img.shields.io/npm/v/@mjxupup/agentlink?color=blue&label=npm)](https://www.npmjs.com/package/@mjxupup/agentlink)
[![GitHub release](https://img.shields.io/github/v/tag/MjxUpUp/AgentLink?color=green&label=release)](https://github.com/MjxUpUp/AgentLink/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-purple.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)

[Installation](#installation) · [Quick Start](#quick-start) · [MCP Tools](#mcp-tools) · [Security](#security-model) · [Configuration](#configuration) · [中文文档](README_CN.md)

</div>

---

## Why AgentLink?

AI coding agents (Claude, Cursor, Copilot) work in isolation. AgentLink lets them **find each other on your LAN**, **communicate securely**, and **delegate tasks** — no cloud, no API keys, no setup wizards.

```
┌─────────────────────────────────────────────────────────┐
│                    AI Agent (MCP Host)                   │
│                  Claude / Cursor / ...                   │
└──────────────────────┬──────────────────────────────────┘
                       │ stdio (MCP)
┌──────────────────────▼──────────────────────────────────┐
│                  AgentLink MCP Server                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │  Tools   │ │Resources │ │ Prompts  │ │TrustManager│ │
│  └────┬─────┘ └──────────┘ └──────────┘ └────────────┘ │
│       │         TaskManager    AuditLogger               │
├───────┼─────────────────────────────────────────────────┤
│       │              Transport (TCP)                     │
│       │         ┌──────────────────────┐                │
│       │         │ XChaCha20-Poly1305   │                │
│       │         │ Ed25519 Key Exchange │                │
│       │         └──────────────────────┘                │
├───────┼─────────────────────────────────────────────────┤
│       │           Discovery (mDNS)                       │
│       │    AddressBook     AgentDatabase (SQLite)        │
└───────┴─────────────────────────────────────────────────┘
                       │ TCP / mDNS
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Agent A      Agent B      Agent C
```

## Features

- **Encrypted P2P Transport** — TCP connections secured with libsodium's XChaCha20-Poly1305 secretstream encryption and Ed25519 key exchange
- **Zero-Config Discovery** — mDNS broadcast/listen with automatic peer detection on the LAN, plus static peer fallback
- **Task Delegation** — Full task lifecycle (create → accept → progress → complete/fail) with priority, timeout, and artifact support
- **Trust Management** — Explicit trust model with auto-approve for known agents, team seed import/export
- **MCP Integration** — Exposes all capabilities as MCP tools, resources, and prompts — works with any MCP-compatible AI agent out of the box
- **Audit Logging** — Every inbound/outbound event is logged as JSONL for full traceability
- **Network Resilience** — Automatic reconnection with exponential backoff, DHCP adaptation, and address book tracking

## Installation

### Option 1: One-click (Claude Desktop)

Download [agentlink.mcpb](https://github.com/MjxUpUp/AgentLink/releases/latest/download/agentlink.mcpb) → double-click → done.

First launch will auto-initialize with defaults.

### Option 2: npm

```bash
npx @mjxupup/agentlink serve
```

First run will guide you through setup. No separate init step needed.

### Option 3: MCP host config (Cursor, VS Code, etc.)

Add to your MCP host config:

```json
{
  "mcpServers": {
    "agentlink": {
      "command": "npx",
      "args": ["-y", "@mjxupup/agentlink", "serve"]
    }
  }
}
```

> [!TIP]
> All three methods auto-initialize on first run — no manual setup required.

## Quick Start

```bash
# Start the MCP server (auto-initializes if first run)
npx @mjxupup/agentlink serve

# Or customize your identity upfront
npx @mjxupup/agentlink init --name "Code Reviewer" --type "reviewer" --capabilities "code-review,testing"

# Check status
npx @mjxupup/agentlink status
```

### CLI Reference

| Command | Description |
|---------|-------------|
| `agentlink init` | Initialize identity and config |
| `agentlink serve` | Start MCP server with P2P transport and discovery |
| `agentlink status` | Show agent status, trust list, and active tasks |
| `agentlink trust list` | List trusted agents |
| `agentlink trust remove <id>` | Remove a trusted agent |

#### Init Options

```
--name <name>              Agent display name (default: hostname)
--type <type>              Agent type: agent, coder, reviewer, etc. (default: agent)
--capabilities <caps>      Comma-separated capability list
```

## MCP Tools

Once running, AgentLink exposes these MCP tools to your AI agent:

| Tool | Description |
|------|-------------|
| `agentlink_discover` | Discover LAN agents. Filter by capability or status. |
| `agentlink_send_message` | Send a message/task to a specific agent. |
| `agentlink_broadcast` | Broadcast a message to all trusted online agents. |
| `agentlink_get_status` | Get detailed info about a specific agent. |
| `agentlink_wait_for_reply` | Block until a task reply arrives or timeout. |

### MCP Resources

| URI | Description |
|-----|-------------|
| `agentlink://agents` | Currently online agents |
| `agentlink://tasks` | Active (non-terminal) tasks |
| `agentlink://trust` | Trusted agents and trust levels |

## Security Model

| Layer | Mechanism |
|-------|-----------|
| **Identity** | Ed25519 key pair generated at init. Agent IDs derived from public key (`al-XXXXXXXX-XXXXXXXX-XXXXXXXX`). |
| **Transport** | All TCP traffic uses XChaCha20-Poly1305 secretstream with session keys derived via `crypto_kx`. |
| **Messages** | Every message signed with sender's Ed25519 secret key, verified on receipt. |
| **Access Control** | Agents start untrusted. Explicit trust grants required for task delegation and broadcasts. |
| **Team Setup** | Export/import trust lists for pre-configured team deployments. |

## Configuration

Config is stored in `~/.agentlink/config.json`:

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

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js (TypeScript, ESM) |
| Transport | Raw TCP with length-framed messages |
| Crypto | libsodium (Ed25519, X25519, XChaCha20-Poly1305) |
| Discovery | bonjour-service (mDNS/DNS-SD) |
| Database | better-sqlite3 (WAL mode) |
| MCP SDK | @modelcontextprotocol/sdk |
| CLI | commander |
| Testing | vitest |

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

<div align="center">

**[Report Bug](https://github.com/MjxUpUp/AgentLink/issues) · [Request Feature](https://github.com/MjxUpUp/AgentLink/issues) · [Download Latest](https://github.com/MjxUpUp/AgentLink/releases/latest)**

</div>
