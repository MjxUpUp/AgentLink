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
