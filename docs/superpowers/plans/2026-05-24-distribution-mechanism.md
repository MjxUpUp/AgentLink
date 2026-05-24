# Distribution Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentLink installable in one step — auto-init on first serve, npm publish ready, and `.mcpb` one-click package for Claude Desktop.

**Architecture:** Add auto-init logic to the CLI serve command (TTY-aware: interactive prompts vs silent defaults). Update package.json for npm publish. Add a DXT manifest.json for `.mcpb` packaging. Rewrite READMEs for dual-track Quick Start.

**Tech Stack:** TypeScript, Node.js readline (built-in), @anthropic-ai/dxt (devDep), vitest

**Spec:** `docs/superpowers/specs/2026-05-23-distribution-mechanism-design.md`

---

## File Structure

| File | Responsibility | Status |
|------|---------------|--------|
| `src/cli/index.ts` | CLI commands — add auto-init before serve | Modify |
| `src/cli/actions.ts` | Action handlers — add `identityExists()` helper | Modify |
| `src/cli/prompts.ts` (new) | Interactive readline prompts for auto-init | Create |
| `src/core/types.ts` | Shared types — update DEFAULT_CONFIG defaults | Modify |
| `package.json` | Publish fields, scripts, declare zod | Modify |
| `manifest.json` (new) | DXT manifest for .mcpb packaging | Create |
| `README.md` | English Quick Start rewrite | Modify |
| `README_CN.md` | Chinese Quick Start rewrite | Modify |
| `tests/cli/prompts.test.ts` (new) | Tests for prompts module | Create |
| `tests/cli/auto-init.test.ts` (new) | Tests for auto-init logic | Create |

---

### Task 1: Add `identityExists()` helper to `actions.ts`

**Files:**
- Modify: `src/cli/actions.ts`
- Test: `tests/integration/cli-init-serve.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/cli-init-serve.test.ts`:

```typescript
import { identityExists } from '../../src/cli/actions.js';

it('identityExists returns false when no identity', () => {
  expect(identityExists(tmpDir)).toBe(false);
});

it('identityExists returns true after init', async () => {
  await initAction(
    { name: 'ExistBot', type: 'test', capabilities: '' },
    tmpDir,
  );
  expect(identityExists(tmpDir)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/cli-init-serve.test.ts`
Expected: FAIL — `identityExists` is not exported

- [ ] **Step 3: Implement `identityExists()`**

Add to `src/cli/actions.ts` after the `getConfigDir()` function:

```typescript
export function identityExists(configDir: string): boolean {
  const identityPath = path.join(configDir, 'identity.json');
  return fs.existsSync(identityPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/cli-init-serve.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/actions.ts tests/integration/cli-init-serve.test.ts
git commit -m "feat: add identityExists helper for auto-init"
```

---

### Task 2: Create prompts module for interactive init

**Files:**
- Create: `src/cli/prompts.ts`
- Create: `tests/cli/prompts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/prompts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseCapabilities, getAutoInitOptions } from '../../src/cli/prompts.js';

describe('prompts', () => {
  it('parseCapabilities splits and trims comma-separated string', () => {
    expect(parseCapabilities('code-review, testing ,deploy')).toEqual([
      'code-review', 'testing', 'deploy',
    ]);
  });

  it('parseCapabilities returns empty for empty string', () => {
    expect(parseCapabilities('')).toEqual([]);
    expect(parseCapabilities('  ')).toEqual([]);
  });

  it('getAutoInitOptions returns defaults with hostname', () => {
    const opts = getAutoInitOptions();
    expect(opts.name.length).toBeGreaterThan(0);
    expect(opts.type).toBe('agent');
    expect(opts.capabilities).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/prompts.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement prompts module**

Create `src/cli/prompts.ts`:

```typescript
import os from 'node:os';
import readline from 'node:readline';

export function parseCapabilities(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getAutoInitOptions(): { name: string; type: string; capabilities: string } {
  return {
    name: os.hostname(),
    type: 'agent',
    capabilities: '',
  };
}

function askQuestion(rl: readline.Interface, prompt: string, defaultVal: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`? ${prompt} (${defaultVal}) `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

export async function promptForInit(): Promise<{ name: string; type: string; capabilities: string }> {
  const defaults = getAutoInitOptions();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  console.log('Welcome to AgentLink! Let\'s set up your agent.\n');

  const name = await askQuestion(rl, 'Agent name', defaults.name);
  const type = await askQuestion(rl, 'Agent type', defaults.type);
  const capabilities = await askQuestion(rl, 'Capabilities (comma-separated)', '');

  rl.close();
  return { name, type, capabilities };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/prompts.ts tests/cli/prompts.test.ts
git commit -m "feat: add prompts module for interactive auto-init"
```

---

### Task 3: Wire auto-init into serve command

**Files:**
- Modify: `src/cli/index.ts`
- Create: `tests/cli/auto-init.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/auto-init.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { identityExists, initAction, serveAction } from '../../src/cli/actions.js';
import { getAutoInitOptions } from '../../src/cli/prompts.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-auto-init-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('auto-init logic', () => {
  it('identityExists is false before init, true after', async () => {
    expect(identityExists(tmpDir)).toBe(false);

    const defaults = getAutoInitOptions();
    await initAction(
      { name: defaults.name, type: defaults.type, capabilities: defaults.capabilities },
      tmpDir,
    );

    expect(identityExists(tmpDir)).toBe(true);

    // Verify identity uses default values
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'));
    expect(data.name).toBe(defaults.name);
    expect(data.agentType).toBe('agent');
    expect(data.capabilities).toEqual([]);
  });

  it('serveAction works after auto-init with defaults', async () => {
    const defaults = getAutoInitOptions();
    await initAction(
      { name: defaults.name, type: defaults.type, capabilities: '' },
      tmpDir,
    );

    const { agentId, server } = await serveAction(tmpDir);
    expect(agentId).toMatch(/^al-/);
    await server.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (these tests use existing functions, should pass already)

Run: `npx vitest run tests/cli/auto-init.test.ts`
Expected: PASS (tests use existing `initAction` directly — they verify the auto-init flow works end-to-end)

- [ ] **Step 3: Modify serve command in `src/cli/index.ts`**

First, add the new imports at the top of the file (replace the existing `import { ... } from './actions.js'`):

```typescript
import path from 'node:path';
import os from 'node:os';
import {
  initAction,
  serveAction,
  trustListAction,
  trustRemoveAction,
  statusAction,
  getConfigDir,
  identityExists,
} from './actions.js';
import { promptForInit, getAutoInitOptions } from './prompts.js';
```

Then replace the serve command block (lines 60-92, from `program.command('serve')` through its closing `});`) with:

```typescript
program
  .command('serve')
  .description('Start AgentLink MCP server')
  .action(async () => {
    const configDir = getConfigDir();

    try {
      // Auto-init: if no identity, create one before serving
      if (!identityExists(configDir)) {
        if (process.stdout.isTTY) {
          const opts = await promptForInit();
          await initAction(opts, configDir);
          console.log('AgentLink initialized!\n');
        } else {
          const opts = getAutoInitOptions();
          await initAction(opts, configDir);
          console.error('[agentlink] No identity found. Auto-initializing with defaults.');
          console.error(`[agentlink] Identity created at ${path.join(configDir, 'identity.json')}`);
          console.error('[agentlink] WARNING: Secret key created. Protect this file.');
          console.error('[agentlink] Run `agentlink init` from a terminal to customize.\n');
        }
      }

      const result = await serveAction(configDir);

      if (process.stdout.isTTY) {
        console.log('AgentLink server starting...');
        console.log('  Agent ID: ' + result.agentId);
      }

      await result.server.start();

      const shutdown = async () => {
        console.log('\nShutting down...');
        try {
          await result.server.stop();
        } catch {
          // Best effort
        }
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli/auto-init.test.ts
git commit -m "feat: auto-init on first serve — interactive in TTY, silent defaults in MCP mode"
```

---

### Task 4: Update DEFAULT_CONFIG defaults and init command defaults

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Update DEFAULT_CONFIG in `src/core/types.ts`**

Change line 137-139 from:

```typescript
  identity: {
    name: '',
    agentType: 'unknown',
```

To:

```typescript
  identity: {
    name: '',
    agentType: 'agent',
```

- [ ] **Step 2: Update init command defaults in `src/cli/index.ts`**

Change the init command's option defaults (lines 23-25) from:

```typescript
  .option('--name <name>', 'Agent name', 'My Agent')
  .option('--type <type>', 'Agent type', 'unknown')
```

To:

```typescript
  .option('--name <name>', 'Agent name', os.hostname())
  .option('--type <type>', 'Agent type', 'agent')
```

Add `import os from 'node:os';` at the top if not already present.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: PASS (existing tests don't depend on specific default values for name/type)

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts src/cli/index.ts
git commit -m "feat: update defaults — hostname for name, agent for type"
```

---

### Task 5: Update package.json for npm publish

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json**

Add the following fields (merge into existing JSON):

```json
{
  "description": "P2P communication layer for AI programming agents",
  "keywords": ["mcp", "agent", "p2p", "ai", "model-context-protocol"],
  "license": "MIT",
  "files": ["dist"],
  "scripts": {
    "prepublishOnly": "npm run build",
    "pack:mcpb": "dxt pack -o agentlink.mcpb"
  }
}
```

Add `"zod": "^3.0.0"` to `dependencies`.

Add the `repository` field:

```json
"repository": { "type": "git", "url": "https://github.com/user/agentlink" }
```

- [ ] **Step 2: Verify build still works**

Run: `npm run build`
Expected: Successful compilation, no errors

- [ ] **Step 3: Verify tests pass**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: add npm publish fields, prepublishOnly, declare zod dependency"
```

---

### Task 6: Add DXT manifest.json

**Files:**
- Create: `manifest.json`

- [ ] **Step 1: Create manifest.json**

Create `manifest.json` at project root:

```json
{
  "manifest_version": "0.2",
  "name": "AgentLink",
  "version": "0.1.0",
  "description": "P2P communication layer for AI programming agents. Connect AI agents on your local network via encrypted channels, discover peers through mDNS, and delegate tasks.",
  "author": {
    "name": "AgentLink Team"
  },
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

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf-8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: add DXT manifest for .mcpb packaging"
```

---

### Task 7: Rewrite READMEs for dual-track Quick Start

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`

- [ ] **Step 1: Rewrite Quick Start section in `README.md`**

Find the section starting with `## Quick Start` and replace everything from there through the line ending with `LAN discovery.` (approximately lines 45-83) with:

```markdown
## Quick Start

### Option 1: One-click install (Claude Desktop)

Download [agentlink.mcpb](https://github.com/user/agentlink/releases) → double-click → done.

First launch will auto-initialize with defaults.

### Option 2: Command line

```bash
npx @agentlink/server serve
```

First run will guide you through setup. No separate init step needed.

### For other MCP hosts (Cursor, VS Code, etc.)

Add to your MCP host config:

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

### Manual init (optional)

```bash
npx agentlink init --name "My Agent" --type "coder" --capabilities "code-review,testing"
```
```

- [ ] **Step 2: Rewrite Quick Start section in `README_CN.md`**

Find the section starting with `## 快速开始` and replace everything from there through the line ending with `局域网发现。` (approximately lines 45-83) with:

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add README.md README_CN.md
git commit -m "docs: rewrite Quick Start for dual-track distribution"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run type check**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Successful compilation

- [ ] **Step 4: Verify auto-init manually**

Run: `AGENTLINK_DIR=$(mktemp -d) node dist/cli/index.js serve` then Ctrl+C immediately.
Expected: Interactive prompts appear, or in non-TTY context, auto-init with defaults.

- [ ] **Step 5: Verify init command still works**

Run: `AGENTLINK_DIR=$(mktemp -d) node dist/cli/index.js init --name TestBot --type coder --capabilities "test"`
Expected: AgentLink initialized, agent ID printed.
