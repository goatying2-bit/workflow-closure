#!/usr/bin/env node
import { createAdminServer } from '../server/admin-server.js';
import { applyClaudeRuntimeWorkingDirectory, getClaudeRuntimeProfile } from './claude-runtime-profile.js';

async function main() {
  const profile = applyClaudeRuntimeWorkingDirectory(getClaudeRuntimeProfile());
  const server = await createAdminServer({
    workspacePath: profile.workspacePath,
    dbPath: profile.dbPath,
    agentId: profile.agent.agentId,
    adapterModule: profile.adapterModulePath
  });
  const info = await server.listen(profile.port, profile.host);

  process.stdout.write(`Claude ops panel listening at ${info.url}\n`);
  process.stdout.write(`workspacePath=${profile.workspacePath}\n`);
  process.stdout.write(`dbPath=${profile.dbPath}\n`);
  process.stdout.write(`agentId=${profile.agent.agentId}\n`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
