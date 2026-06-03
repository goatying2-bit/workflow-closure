import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');
const dbPath = path.join(__dirname, 'stale-lock-smoke-test.db');
const lockPath = `${dbPath}.lock`;

async function main() {
  await fs.rm(dbPath, { force: true });
  await fs.rm(lockPath, { force: true });
  await fs.writeFile(lockPath, '999999');

  const created = await runCli('create-workflow', {
    dbPath,
    workflowId: 'stale-lock-smoke-workflow',
    instruction: 'stale db lock should be reclaimed automatically'
  });

  assert(created.command === 'create-workflow', 'create-workflow should echo command');
  assert(created.status === 'ok', 'create-workflow should succeed through stale lock recovery');
  assert(created.workflow?.workflowId === 'stale-lock-smoke-workflow', 'workflow should be created after reclaiming stale lock');

  const lockStillExists = await fs.access(lockPath).then(() => true).catch(() => false);
  assert(lockStillExists === false, 'reclaimed stale lock file should be removed after command completion');

  console.log('stale-lock smoke test passed');
  console.log(JSON.stringify({
    workflowId: created.workflow.workflowId,
    finalStatus: created.workflow.status,
    lockRecovered: true
  }, null, 2));
}

async function runCli(command, input) {
  const args = [cliPath, command, '--input', JSON.stringify(input)];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

  if (result.code !== 0) {
    throw new Error(`CLI command failed: ${command}\n${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  closeDb();
  await fs.rm(dbPath, { force: true }).catch(() => {});
  await fs.rm(lockPath, { force: true }).catch(() => {});
});
