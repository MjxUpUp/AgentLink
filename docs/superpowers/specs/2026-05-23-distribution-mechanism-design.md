# AgentLink Distribution Mechanism Design

**Date:** 2026-05-23
**Status:** Approved
**Scope:** Installation packaging and distribution — no discovery marketplace, no registry.

## Goal

Make AgentLink installable by anyone — from a non-technical product manager to a developer — with the fewest possible steps.

## Design

### Dual-track distribution

| Track | Target user | Install experience |
|-------|-------------|--------------------|
| `.mcpb` one-click package | Claude Desktop users (non-technical) | Download → double-click → done |
| npm publish + `npx` | Developers, other MCP hosts | `npx @agentlink/server serve` → interactive init → done |

Both tracks share the same codebase. The `.mcpb` file is a thin wrapper around the npm package.

### 1. Auto-init on first serve

Currently, users must run `agentlink init` then `agentlink serve` — two steps.

**Change:** When `serve` starts and `~/.agentlink/identity.json` does not exist, prompt interactively:

```
Welcome to AgentLink! Let's set up your agent.

? Agent name: (my-laptop) _
? Agent type: (coder) _
? Capabilities (comma-separated): (code-review, testing) _
```

Each prompt shows a default value in parentheses. Pressing Enter accepts the default.

- Default name: `os.hostname()`
- Default type: `agent`
- Default capabilities: empty

After init completes, continue to start the server normally. This is not a separate command — it's inline in the serve flow.

**Implementation:** Modify `serveAction()` in `src/cli/actions.ts`. Before loading identity, check if `identity.json` exists. If not, call `initAction()` with prompts via `readline` (Node built-in, no new dependency).

### 2. npm publish

**`package.json` changes:**

```jsonc
{
  "description": "P2P communication layer for AI programming agents",
  "keywords": ["mcp", "agent", "p2p", "ai", "model-context-protocol"],
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/user/agentlink" },
  "files": ["dist"],
  "scripts": {
    "prepare": "npm run build",
    "pack:mcpb": "dxt pack"
  }
}
```

- `files` limits published content to `dist/`
- `prepare` ensures the package builds on install
- Existing `bin.agentlink` field already points to `./dist/cli/index.js`

**After publish, user experience:**

```bash
npx @agentlink/server serve
# First run → interactive init → server starts
```

Works on any MCP host by adding to config:

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

### 3. `.mcpb` one-click package

**`manifest.json` (project root, new file):**

Describes the MCP server for Claude Desktop's extension installer:
- Entry point: `node ./dist/cli/index.js serve`
- Tools: agentlink_discover, agentlink_send_message, agentlink_broadcast, agentlink_get_status, agentlink_wait_for_reply
- Resources: agentlink://agents, agentlink://tasks, agentlink://trust
- No user-configurable fields (init is handled interactively at first run)

**Packaging:**

```bash
npm run pack:mcpb   # runs: dxt pack
```

Produces `agentlink.mcpb` — a bundled file containing the server code, dependencies, and manifest.

**Distribution:** Attach `.mcpb` to GitHub Releases on each version tag.

### 4. README update

Rewrite Quick Start section:

```markdown
## Quick Start

### Option 1: One-click install (Claude Desktop)
Download [agentlink.mcpb](releases) → double-click → done.

### Option 2: Command line
npx @agentlink/server serve
First run will guide you through setup.

### For other MCP hosts (Cursor, VS Code, etc.)
{existing JSON config example}
```

### 5. CI/CD (future, not in initial scope)

On `git tag v*`:
1. `npm publish`
2. Build `.mcpb`
3. Upload `.mcpb` to GitHub Release

Can be a GitHub Actions workflow. Out of scope for this design but the `pack:mcpb` script is ready for it.

## Files to change

| File | Change |
|------|--------|
| `src/cli/actions.ts` | Interactive init in serveAction when no identity exists |
| `package.json` | Add publish fields, `prepare` script, `pack:mcpb` script |
| `manifest.json` (new) | MCPB/DXT manifest describing server metadata |
| `README.md` | Rewrite Quick Start for dual-track |
| `README_CN.md` | Same update in Chinese |

## Dependencies

- `@anthropic-ai/dxt` (devDependency) — for `dxt pack` command
- `readline` (Node built-in) — for interactive prompts, no new dep needed

## Non-goals

- No agent marketplace or discovery registry
- No auto-update mechanism
- No signing/verification of `.mcpb` files (beyond what DXT provides)
- No Windows `.exe` / macOS `.dmg` installer
