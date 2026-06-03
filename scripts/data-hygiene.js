import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, withDbLock } from '../storage/db.js';
import { classifyWorkflow, markWorkflowPlanArchived } from '../storage/data-hygiene.js';
import { getWorkflowStore } from '../storage/workflows.js';
import { getAgentStore } from '../storage/agents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const scriptsDir = path.join(rootDir, 'scripts');
const storageDir = path.join(rootDir, 'storage');
const tmpDbDir = path.join(scriptsDir, '.tmp', 'db');
const runtimeArtifactTargets = [
  {
    path: path.join(rootDir, 'artifacts'),
    kind: 'workflow-artifacts',
    reason: 'generated workflow artifact output',
    cleanable: true
  },
  {
    path: path.join(storageDir, 'test-workspaces'),
    kind: 'test-workspaces',
    reason: 'generated test workspace data',
    cleanable: true
  },
  {
    path: path.join(rootDir, '.claude', 'worktrees'),
    kind: 'agent-worktrees',
    reason: 'agent worktree state; inspect before deleting',
    cleanable: false
  },
  {
    path: path.join(storageDir, 'workspaces'),
    kind: 'runtime-workspace-dbs',
    reason: 'runtime workspace/profile databases; may contain real workflow state',
    cleanable: false
  }
];
const defaultProtectedWorkflowIds = new Set(['write-doc-workflow']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = hasFlag(args, 'apply');
  const includeScripts = hasFlag(args, 'scripts') || hasFlag(args, 'clean-script-dbs');
  const runtimeDb = getOption(args, 'runtime-db');

  const result = {
    status: 'ok',
    mode: apply ? 'apply' : 'dry-run',
    scriptDbs: [],
    runtimeArtifacts: [],
    workflows: [],
    changes: []
  };

  if (includeScripts) {
    result.scriptDbs = await auditScriptDbs();
  }

  if (hasFlag(args, 'runtime-artifacts')) {
    result.runtimeArtifacts = await auditRuntimeArtifacts();
  }

  if (hasFlag(args, 'clean-script-dbs')) {
    result.changes.push(...await cleanScriptDbs(result.scriptDbs, { apply }));
  }

  if (hasFlag(args, 'clean-runtime-artifacts')) {
    result.runtimeArtifacts = result.runtimeArtifacts.length > 0
      ? result.runtimeArtifacts
      : await auditRuntimeArtifacts();
    result.changes.push(...await cleanRuntimeArtifacts(result.runtimeArtifacts, { apply }));
  }

  if (runtimeDb) {
    result.workflows = await auditRuntimeDb(runtimeDb);
  }

  if (hasFlag(args, 'mark-test')) {
    if (!runtimeDb) {
      throw new Error('--mark-test requires --runtime-db.');
    }

    result.changes.push(await markWorkflowTest(runtimeDb, args, { apply }));
    result.workflows = await auditRuntimeDb(runtimeDb);
  }

  if (!includeScripts && !runtimeDb && !hasFlag(args, 'mark-test') && !hasFlag(args, 'runtime-artifacts') && !hasFlag(args, 'clean-runtime-artifacts')) {
    throw new Error('Nothing to do. Pass --scripts, --runtime-artifacts, --runtime-db <path>, --mark-test, --clean-script-dbs, or --clean-runtime-artifacts.');
  }

  console.log(JSON.stringify(result, null, 2));
}

async function auditScriptDbs() {
  const paths = [
    ...await listDbFiles(scriptsDir),
    ...await listDbFiles(tmpDbDir)
  ];
  const uniquePaths = [...new Set(paths.map((item) => path.resolve(item)))];
  const entries = [];

  for (const dbPath of uniquePaths.sort()) {
    const stat = await fs.stat(dbPath);
    entries.push({
      path: dbPath,
      relativePath: path.relative(rootDir, dbPath),
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      reason: dbPath.startsWith(path.resolve(tmpDbDir))
        ? 'temporary script test database'
        : 'legacy root-level script database'
    });
  }

  return entries;
}

async function listDbFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
    .map((entry) => path.join(directory, entry.name));
}

async function cleanScriptDbs(scriptDbs, options = {}) {
  const changes = [];

  for (const entry of scriptDbs) {
    const change = {
      action: 'delete-script-db',
      path: entry.path,
      applied: false
    };

    if (options.apply) {
      await fs.rm(entry.path, { force: true });
      await fs.rm(`${entry.path}-shm`, { force: true });
      await fs.rm(`${entry.path}-wal`, { force: true });
      await fs.rm(`${entry.path}.lock`, { force: true });
      change.applied = true;
    }

    changes.push(change);
  }

  return changes;
}


async function auditRuntimeArtifacts() {
  const entries = [];

  for (const target of runtimeArtifactTargets) {
    const stat = await statOptional(target.path);
    if (!stat) {
      continue;
    }

    entries.push({
      path: target.path,
      relativePath: path.relative(rootDir, target.path),
      kind: target.kind,
      reason: target.reason,
      cleanable: target.cleanable,
      sizeBytes: await sumPathSize(target.path),
      mtime: stat.mtime.toISOString()
    });
  }

  return entries;
}

async function cleanRuntimeArtifacts(entries, options = {}) {
  const changes = [];

  for (const entry of entries) {
    const change = {
      action: 'delete-runtime-artifact-target',
      path: entry.path,
      kind: entry.kind,
      applied: false
    };

    if (!entry.cleanable) {
      changes.push({
        ...change,
        skipped: true,
        reason: 'target is not marked cleanable; inspect and delete manually if intentional'
      });
      continue;
    }

    if (options.apply) {
      await fs.rm(entry.path, { recursive: true, force: true });
      change.applied = true;
    }

    changes.push(change);
  }

  return changes;
}

async function statOptional(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function sumPathSize(targetPath) {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return 0;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await sumPathSize(path.join(targetPath, entry.name));
  }
  return total;
}

async function auditRuntimeDb(dbPath) {
  const workflowStore = getWorkflowStore({ dbPath });
  const agentStore = getAgentStore({ dbPath });
  const workflows = workflowStore.listWorkflows({ includeTestData: true, includeArchived: true, limit: 10000 });

  return workflows.map((workflow) => {
    const hygiene = classifyWorkflow(workflow);
    return {
      workflowId: workflow.workflowId,
      status: workflow.status,
      goal: workflow.goal,
      instruction: summarizeText(workflow.instruction),
      dataClass: hygiene.dataClass,
      retention: hygiene.retention,
      generatedBy: hygiene.generatedBy || null,
      archived: hygiene.archived,
      archivedAt: hygiene.archivedAt,
      archiveReason: hygiene.archiveReason,
      heuristicReasons: hygiene.heuristicReasons,
      counts: countWorkflowRelatedRows(workflowStore, agentStore, workflow.workflowId),
      updatedAt: workflow.updatedAt
    };
  });
}

function countWorkflowRelatedRows(workflowStore, agentStore, workflowId) {
  return {
    tasks: workflowStore.listWorkflowTasks(workflowId).length,
    runLogs: workflowStore.listWorkflowRunLogs(workflowId, { limit: 100000 }).length,
    assignments: agentStore.listAssignments({ workflowId, limit: 100000 }).length,
    handoffs: agentStore.listHandoffs({ workflowId, limit: 100000 }).length
  };
}

async function markWorkflowTest(dbPath, args, options = {}) {
  const workflowId = getOption(args, 'workflow-id');
  if (!workflowId) {
    throw new Error('--mark-test requires --workflow-id <id>.');
  }

  const protectedWorkflowIds = new Set([
    ...defaultProtectedWorkflowIds,
    ...getOptions(args, 'protect-workflow')
  ]);

  if (protectedWorkflowIds.has(workflowId)) {
    throw new Error(`Refusing to mark protected workflow: ${workflowId}`);
  }

  const reason = getOption(args, 'reason') || 'old test/debug workflow';
  const change = {
    action: 'mark-test-workflow',
    workflowId,
    reason,
    applied: false
  };

  if (!options.apply) {
    return change;
  }

  await withDbLock(dbPath, async (database) => {
    const store = getWorkflowStore({ dbPath });
    const workflow = store.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const hygiene = classifyWorkflow(workflow);
    if (hygiene.dataClass === 'real') {
      throw new Error(`Refusing to mark real workflow as test: ${workflowId}`);
    }

    const nextPlan = markWorkflowPlanArchived(workflow.initialPlan || {}, {
      dataClass: 'test',
      retention: 'ephemeral',
      generatedBy: 'data-hygiene',
      archiveReason: reason
    });
    const now = new Date().toISOString();

    database.prepare(`
      UPDATE workflows
      SET initial_plan_json = ?, updated_at = ?
      WHERE workflow_id = ?
    `).run(JSON.stringify(nextPlan), now, workflowId);
  });

  change.applied = true;
  return change;
}

function summarizeText(value, maxLength = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function parseArgs(argv) {
  const args = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args.push({ name, value: true });
      continue;
    }

    args.push({ name, value: next });
    index += 1;
  }

  return args;
}

function hasFlag(args, name) {
  return args.some((arg) => arg.name === name);
}

function getOption(args, name) {
  const match = args.findLast((arg) => arg.name === name && arg.value !== true);
  return match ? String(match.value).trim() : '';
}

function getOptions(args, name) {
  return args
    .filter((arg) => arg.name === name && arg.value !== true)
    .map((arg) => String(arg.value).trim())
    .filter(Boolean);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  closeDb();
});
