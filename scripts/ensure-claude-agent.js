#!/usr/bin/env node
import { applyClaudeRuntimeWorkingDirectory, getClaudeRuntimeProfile } from './claude-runtime-profile.js';
import { ensureClaudeRuntimeAgent } from './claude-runtime-agent.js';

async function main() {
  const profile = applyClaudeRuntimeWorkingDirectory(getClaudeRuntimeProfile());
  const result = await ensureClaudeRuntimeAgent(profile);

  process.stdout.write(`${JSON.stringify({
    status: result.status,
    agent: result.agent,
    runtime: {
      workspacePath: profile.workspacePath,
      dbPath: profile.dbPath,
      adapterModule: profile.adapterModulePath
    }
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
