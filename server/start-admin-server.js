#!/usr/bin/env node
import { createAdminServer } from './admin-server.js';

import { resolveAdminServerListenOptions } from './admin-server-config.js';

async function main() {
  const { host, port } = resolveAdminServerListenOptions({ env: process.env });
  const dbProfile = process.env.WORKFLOW_DB_PROFILE || process.env.DB_PROFILE || undefined;
  const server = await createAdminServer({
    workspacePath: process.cwd(),
    ...(dbProfile ? { dbProfile } : {})
  });
  const info = await server.listen(port, host);
  process.stdout.write(`Ops panel listening at ${info.url}\n`);

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
