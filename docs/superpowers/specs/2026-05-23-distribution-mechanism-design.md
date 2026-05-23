# AgentLink Distribution Mechanism Design

**Date:** 2026-05-23
**Status:** Approved (revised after spec review)
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

**Change:** When `serve` starts and `~/.agentlink/identity.json` does not exist:

- **Terminal mode** (`process.stdout.isTTY === true`): Interactive prompts via `readline`:

```
Welcome to AgentLink! Let's set up your agent.

? Agent name: (my-laptop) _
? Agent type: (agent) _
? Capabilities (comma-separated): _
```

Each prompt shows a default value in parentheses. Pressing Enter accepts the default.

- **MCP host mode** (`process.stdout.isTTY === false`): Use defaults silently, print identity path and warning to stderr:

```
[agentlink] No identity found. Auto-initializing with defaults.
[agentlink] Identity created at ~/.agentlink/identity.json
[agentlink] Run `agentlink init` from a terminal to customize.
```

Defaults:
- Name: `os.hostname()`
- Type: `agent`
- Capabilities: empty

**Implementation:** Modify the serve command handler in `src/cli/index.ts`. Before calling `serveAction()`, check if identity exists. If not, prompt in the CLI layer (not in `serveAction()`) then call the existing `initAction()` with the collected or default values. This keeps `serveAction()` clean — it continues to expect identity to exist.

**Security note:** Auto-init creates a secret key at `~/.agentlink/identity.json` (mode 0o600). In MCP host mode this happens silently. Print the file path and a security note to stderr.

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
    "prepublishOnly": "npm run build",
    "pack:mcpb": "dxt pack -o agentlink.mcpb"
  }
}
```

- `files` limits published content to `dist/`
- `prepublishOnly` builds before publish on the publisher's machine — NOT `prepare`, which would force consumers to have a full TypeScript + native addon toolchain
- Existing `bin.agentlink` field already points to `./dist/cli/index.js`
- Add `"zod": "^3.0.0"` to `dependencies` (currently undeclared, used in `src/mcp/tools.ts`)

**After publish, user experience:**

```bash
npx @agentlink/server serve
# First run → interactive init (or silent defaults in MCP mode) → server starts
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

#### 3a. Native dependency challenge

`better-sqlite3` and `libsodium-wrappers` are native Node.js addons compiled for a specific OS/arch. A `.mcpb` file built on one platform won't work on another.

**Strategy:** Build platform-specific `.mcpb` files and label them clearly:

- `agentlink-win32-x64.mcpb`
- `agentlink-darwin-arm64.mcpb`
- `agentlink-darwin-x64.mcpb`
- `agentlink-linux-x64.mcpb`

Each is built on (or cross-compiled for) its target platform via CI. The README and GitHub Release page clearly indicate which file to download.

**Future consideration:** Migrate `better-sqlite3` → `sql.js` (pure WASM) and `libsodium-wrappers` → `libsodium-wrappers-sumo` (WASM build) to eliminate native dependencies entirely and ship a single portable `.mcpb`. This is out of scope for the initial implementation but should be tracked.

#### 3b. manifest.json

Place in project root. Follows the DXT `manifest_version: "0.2"` schema:

```json
{
  "manifest_version": "0.2",
  "name": "AgentLink",
  "version": "0.1.0",
  "description": "P2P communication layer for AI programming agents",
  "author": { "name": "AgentLink Team" },
  "compatibility": {
    "node": ">=18.0.0",
    "platforms": ["win32", "darwin", "linux"]
  },
  "server": {
    "type": "node",
    "entry_point": "dist/cli/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/dist/cli/index.js", "serve"]
    }
  },
  "tools_generated": true,
  "user_config": {}
}
```

Notes:
- `tools_generated: true` — tools are registered dynamically at runtime, not declared statically
- Resources are not declared — MCP resources are inherently dynamic per the DXT spec
- `user_config: {}` — no user-configurable fields; init is handled at first run
- Node >=18 required (project uses ESM with Node16 module resolution and `import.meta.url`)

#### 3c. Packaging

```bash
npm run pack:mcpb   # runs: dxt pack -o agentlink.mcpb
```

The `-o` flag controls output filename (defaults to directory name otherwise).

**Distribution:** Attach `.mcpb` files to GitHub Releases on each version tag.

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
2. Build platform-specific `.mcpb` files on each target OS
3. Upload all `.mcpb` files to GitHub Release

Can be a GitHub Actions matrix workflow. Out of scope for this design but `pack:mcpb` and `prepublishOnly` scripts are ready for it.

## Files to change

| File | Change |
|------|--------|
| `src/cli/index.ts` | Add auto-init logic before serve: detect identity, prompt or use defaults |
| `src/cli/actions.ts` | No change needed — `initAction()` is called as-is |
| `src/core/types.ts` | Update `DEFAULT_CONFIG`: name → `os.hostname()`, agentType → `"agent"` |
| `package.json` | Add publish fields, `prepublishOnly`, `pack:mcpb`, declare `zod` |
| `manifest.json` (new) | DXT manifest describing server metadata |
| `README.md` | Rewrite Quick Start for dual-track |
| `README_CN.md` | Same update in Chinese |

## Dependencies

- `@anthropic-ai/dxt` (devDependency) — for `dxt pack` command. Note: this package is expected to migrate to `@anthropic-ai/mcpb`; the `pack:mcpb` script may need updating when that happens.
- `readline` (Node built-in) — for interactive prompts in TTY mode
- `zod` (dependency) — already used in `src/mcp/tools.ts`, must be declared explicitly

## Non-goals

- No agent marketplace or discovery registry
- No auto-update mechanism
- No signing/verification of `.mcpb` files (beyond what DXT provides)
- No Windows `.exe` / macOS `.dmg` installer
- No migration to WASM-based SQLite/libsodium (tracked as future improvement)
