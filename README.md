# AgentLink

P2P communication layer for AI programming agents. Connect AI agents on your local network via encrypted channels, discover peers through mDNS, and delegate tasks — all through the Model Context Protocol (MCP).

## Features

- **Encrypted P2P Transport** — TCP connections secured with libsodium's XChaCha20-Poly1305 secretstream encryption and Ed25519 key exchange
- **Zero-Config Discovery** — mDNS broadcast/listen with automatic peer detection on the LAN, plus static peer fallback
- **Task Delegation** — Full task lifecycle (create → accept → progress → complete/fail) with priority, timeout, and artifact support
- **Trust Management** — Explicit trust model with auto-approve for known agents, team seed import/export
- **MCP Integration** — Exposes all capabilities as MCP tools, resources, and prompts — works with any MCP-compatible AI agent out of the box
- **Audit Logging** — Every inbound/outbound event is logged as JSONL for full traceability
- **Network Resilience** — Automatic reconnection with exponential backoff, DHCP adaptation, and address book tracking

## Architecture

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

## Quick Start

### Option 1: One-click install (Claude Desktop)

Download [agentlink.mcpb](https://github.com/MjxUpUp/AgentLink/releases/latest/download/agentlink.mcpb) → double-click → done.

First launch will auto-initialize with defaults.

### Option 2: Command line

```bash
npx @mjxupup/agentlink serve
```

First run will guide you through setup. No separate init step needed.

### For other MCP hosts (Cursor, VS Code, etc.)

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

### Manual init (optional)

```bash
npx agentlink init --name "My Agent" --type "coder" --capabilities "code-review,testing"
```

## CLI

```
agentlink init     Initialize identity and config
agentlink serve    Start MCP server with P2P transport and discovery
agentlink status   Show agent status, trust list, and active tasks
agentlink trust list     List trusted agents
agentlink trust remove <agent-id>   Remove a trusted agent
```

### Init Options

```
--name <name>              Agent display name
--type <type>              Agent type (e.g. coder, reviewer)
--capabilities <caps>      Comma-separated capability list
```

## MCP Tools

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

- **Ed25519 Identity** — Each agent generates a key pair at init. Agent IDs are derived from the public key (`al-XXXXXXXX-XXXXXXXX-XXXXXXXX`).
- **Encrypted Transport** — All TCP traffic uses XChaCha20-Poly1305 secretstream with session keys derived via `crypto_kx`.
- **Signed Messages** — Every message is signed with the sender's Ed25519 secret key and verified on receipt.
- **Trust-Based Access** — Agents start as untrusted. Explicit trust grants are required for task delegation and broadcasts.
- **Team Seeds** — Export/import trust lists for pre-configured team setups.

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

## Project Structure

```
src/
├── cli/               # CLI entry point (commander)
│   ├── index.ts
│   └── actions.ts
├── core/
│   ├── identity.ts    # Ed25519 key generation, signing, verification
│   ├── transport.ts   # TCP transport with encrypted secretstream
│   ├── discovery.ts   # mDNS broadcast/listen + static peers
│   ├── task-manager.ts # Task lifecycle (SQLite-backed)
│   ├── trust-manager.ts # Trust store with team seed import/export
│   ├── audit-logger.ts  # JSONL audit logging
│   ├── address-book.ts  # Peer address tracking
│   └── types.ts       # All shared types and constants
├── db/
│   └── database.ts    # SQLite schema and queries
├── mcp/
│   ├── server.ts      # AgentLinkServer — wires all modules together
│   └── tools.ts       # MCP tools, resources, and prompts
└── index.ts           # Public API exports
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint (type check)
npm run lint
```

## Tech Stack

- **Runtime:** Node.js (TypeScript, ESM)
- **Transport:** Raw TCP with length-framed messages
- **Crypto:** libsodium (Ed25519 signing, X25519 key exchange, XChaCha20-Poly1305 encryption)
- **Discovery:** bonjour-service (mDNS/DNS-SD)
- **Database:** better-sqlite3 (WAL mode)
- **MCP:** @modelcontextprotocol/sdk
- **CLI:** commander
- **Testing:** vitest

## License

MIT
