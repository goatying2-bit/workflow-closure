import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeWorkflowHygieneMetadata } from '../../storage/data-hygiene.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptsDir = path.dirname(__dirname);
const tmpDbDir = path.join(scriptsDir, '.tmp', 'db');

export async function prepareTestDb(scriptName) {
  const dbPath = resolveTestDbPath(scriptName);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.rm(dbPath, { force: true });
  await fs.rm(`${dbPath}.lock`, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });
  await fs.rm(`${dbPath}-wal`, { force: true });
  return dbPath;
}

export function resolveTestDbPath(scriptName) {
  const safeName = String(scriptName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!safeName) {
    throw new Error('Test DB script name is required.');
  }

  return path.join(tmpDbDir, `${safeName}.db`);
}

export function markTestPlan(plan = {}, generatedBy = 'smoke-test') {
  return mergeWorkflowHygieneMetadata(plan, {
    dataClass: 'test',
    retention: 'ephemeral',
    generatedBy
  });
}
