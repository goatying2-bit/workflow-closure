import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkflowRuntime } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');

async function main() {
  const packageScripts = {
    'smoke-test': 'node ./scripts/smoke-test.js',
    'runner-smoke-test': 'node ./scripts/runner-smoke-test.js',
    'verifier-smoke-test': 'node ./scripts/verifier-smoke-test.js',
    'cli-smoke-test': 'node ./scripts/cli-smoke-test.js',
    'agent-contract-smoke-test': 'node ./scripts/agent-contract-smoke-test.js'
  };

  const temporary = resolveWorkflowRuntime({
    instruction: 'quick smoke validation for CLI change',
    workspacePath: rootDir,
    projectKey: 'runtime-resolver-smoke',
    temporary: true,
    changedFiles: ['cli.js'],
    packageScripts
  });
  assert(temporary.workflowMode === 'coding-workflow', 'temporary coding change should select coding-workflow');
  assert(temporary.closureMode === 'small_loop', 'single CLI change should stay small loop');
  assert(temporary.boundary.workflowHygieneMetadata.dataClass === 'test', 'temporary runtime should be test data');
  assert(temporary.boundary.workflowHygieneMetadata.retention === 'ephemeral', 'temporary runtime should be ephemeral');
  assert(temporary.boundary.cleanupPolicy.autoCleanCandidates.includes('artifacts'), 'temporary runtime should include artifacts as cleanup candidate');
  assert(temporary.validation.commands.some((command) => command.script === 'cli-smoke-test'), 'CLI changes should select cli-smoke-test');

  const real = resolveWorkflowRuntime({
    instruction: '整理真实业务任务',
    workspacePath: 'F:/linshi1/client-audit',
    projectKey: 'client-audit',
    dbProfile: 'client-audit',
    sessionId: 'audit-001',
    dataClass: 'real',
    retention: 'keep'
  });
  assert(real.workflowMode === 'workflow', 'plain real project task should default to workflow');
  assert(real.boundary.kind === 'project-boundary', 'real project should use project boundary');
  assert(real.boundary.db.recoverySelector.dbProfile === 'client-audit', 'real project recovery selector should preserve dbProfile');
  assert(real.boundary.workflowHygieneMetadata.dataClass === 'real', 'real project should be real data');
  assert(real.boundary.workflowHygieneMetadata.retention === 'keep', 'real project should keep data');

  const highRisk = resolveWorkflowRuntime({
    instruction: '端到端迁移数据库协议并协调多个 agent 验证',
    workspacePath: rootDir,
    dbProfile: 'runtime-resolver-high-risk',
    dataClass: 'real',
    retention: 'keep',
    riskLevel: 'high',
    requiresCoordination: true,
    agentPool: [{ agentId: 'researcher' }, { agentId: 'implementer' }],
    changedFiles: ['core/workflow-engine.js', 'runner/workflow-runner.js', 'runner/prompt-builder.js', 'storage/workflows.js'],
    packageScripts
  });
  assert(highRisk.workflowMode === 'coordinator', 'multi-agent high-risk task should select coordinator');
  assert(highRisk.closureMode === 'large_loop', 'high-risk multi-agent task should be large loop');
  assert(highRisk.runtimePolicy.verificationLevel === 'broad', 'large loop should use broad verification');
  assert(highRisk.validation.commands.length >= 3, 'high-risk changed files should select multiple validation commands');

  const cli = await runCli([
    'resolve-workflow-runtime',
    '--input',
    JSON.stringify({
      instruction: 'quick smoke validation for CLI change',
      workspacePath: rootDir,
      projectKey: 'runtime-resolver-cli',
      temporary: true,
      changedFiles: ['cli.js'],
      packageScripts
    })
  ]);
  assert(cli.status === 'ok', 'CLI resolver command should succeed');
  assert(cli.command === 'resolve-workflow-runtime', 'CLI resolver should report command name');
  assert(cli.runtime?.workflowMode === 'coding-workflow', 'CLI resolver should return runtime selection');
  assert(cli.runtime?.boundary?.workflowHygieneMetadata?.dataClass === 'test', 'CLI resolver should return pollution boundary');
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`CLI exited with ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse CLI JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
