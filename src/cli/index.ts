#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
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

const program = new Command();
program
  .name('agentlink')
  .description('P2P communication for AI agents')
  .version('0.1.0');

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize AgentLink identity and config')
  .option('--name <name>', 'Agent name', os.hostname())
  .option('--type <type>', 'Agent type', 'agent')
  .option('--capabilities <caps>', 'Comma-separated capabilities', '')
  .action(async (opts) => {
    const configDir = getConfigDir();

    try {
      const result = await initAction(
        { name: opts.name, type: opts.type, capabilities: opts.capabilities },
        configDir,
      );

      console.log('AgentLink initialized!');
      console.log('');
      console.log('  Agent ID:    ' + result.agentId);
      console.log('  Fingerprint: ' + result.fingerprint);
      console.log('');
      console.log('Add this to your MCP host agent config:');
      console.log(JSON.stringify({
        mcpServers: {
          agentlink: {
            command: 'npx',
            args: ['-y', '@agentlink/server', 'serve'],
          },
        },
      }, null, 2));
    } catch (err: any) {
      console.error(err.message);
      if (err.message.includes('already exists')) {
        console.error('Remove ~/.agentlink/identity.json to re-initialize.');
      }
      process.exit(1);
    }
  });

// ── serve ─────────────────────────────────────────────────────────────────────

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
        process.stderr.write('AgentLink server starting...\n');
        process.stderr.write('  Agent ID: ' + result.agentId + '\n');
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

// ── trust ─────────────────────────────────────────────────────────────────────

const trustCmd = program
  .command('trust')
  .description('Manage trusted agents');

trustCmd
  .command('list')
  .description('List trusted agents')
  .action(() => {
    const configDir = getConfigDir();
    const entries = trustListAction(configDir);

    if (entries.length === 0) {
      console.log('No trusted agents.');
      return;
    }

    // Print table header
    const idHeader = 'Agent ID';
    const aliasHeader = 'Alias';
    const sinceHeader = 'Trusted Since';
    const maxIdLen = Math.max(idHeader.length, ...entries.map((e) => e.agentId.length));
    const maxAliasLen = Math.max(aliasHeader.length, ...entries.map((e) => e.alias.length));

    const header = `  ${idHeader.padEnd(maxIdLen)}  ${aliasHeader.padEnd(maxAliasLen)}  ${sinceHeader}`;
    const separator = '  ' + '-'.repeat(maxIdLen) + '  ' + '-'.repeat(maxAliasLen) + '  ' + '-'.repeat(sinceHeader.length);

    console.log(header);
    console.log(separator);

    for (const entry of entries) {
      console.log(`  ${entry.agentId.padEnd(maxIdLen)}  ${entry.alias.padEnd(maxAliasLen)}  ${entry.trustedSince}`);
    }
  });

trustCmd
  .command('remove')
  .description('Remove a trusted agent')
  .argument('<agent-id>', 'Agent ID to remove')
  .action((agentId: string) => {
    const configDir = getConfigDir();
    const removed = trustRemoveAction(configDir, agentId);

    if (removed) {
      console.log('Removed trust for: ' + agentId);
    } else {
      console.log('Agent not found in trust store: ' + agentId);
    }
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show AgentLink status')
  .action(() => {
    const configDir = getConfigDir();

    try {
      const info = statusAction(configDir);

      console.log('AgentLink Status');
      console.log('');
      console.log('  Agent ID:      ' + info.agentId);
      console.log('  Name:          ' + info.name);
      console.log('  Type:          ' + info.agentType);
      console.log('  Capabilities:  ' + (info.capabilities.length > 0 ? info.capabilities.join(', ') : '(none)'));
      console.log('  Trusted agents: ' + info.trustedAgents);
      console.log('  Active tasks:   ' + info.activeTasks);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

program.parse();
