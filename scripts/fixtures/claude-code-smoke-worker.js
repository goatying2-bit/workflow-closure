import fs from 'node:fs';

const chunks = [];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const request = JSON.parse(chunks.join('') || '{}');
  const input = request.input || {};
  const prompt = process.argv[process.argv.length - 1] || input.prompt || '';
  const task = input.task || {};
  const mode = resolveMode(process.argv);

  if (mode === 'transient-once') {
    process.stderr.write(`network error: transient smoke failure for ${task.title || 'unknown-task'}\n`);
    process.exit(75);
    return;
  }

  if (mode === 'transient-api-502-once') {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      duration_ms: 1234,
      result: 'API Error: 502 {"error":{"message":"Upstream request failed","type":"upstream_error"}}'
    }));
    process.exit(1);
    return;
  }

  if (mode === 'transient-api-502-always') {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      duration_ms: 1234,
      result: 'API Error: 502 {"error":{"message":"Upstream request failed repeatedly","type":"upstream_error"}}'
    }));
    process.exit(1);
    return;
  }

  if (mode === 'blocked') {
    process.stdout.write(JSON.stringify({
      status: 'blocked',
      blockedReason: `claude-code smoke blocked: ${task.title || 'unknown-task'}`,
      payload: buildSmokePayload({ mode, task, prompt }),
      handoff: {
        summary: 'claude-code smoke blocked handoff',
        artifacts: [],
        decisions: [],
        openQuestions: ['需要人工恢复 smoke blocked 任务'],
        risks: [],
        recommendedNextRole: null
      }
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    status: 'done',
    doneSummary: `claude-code smoke done: ${task.title || 'unknown-task'}`,
    payload: buildSmokePayload({ mode, task, prompt }),
    handoff: {
      summary: mode === 'done-after-transient' || mode === 'done-after-transient-api-502'
        ? 'claude-code smoke recovered handoff'
        : 'claude-code smoke done handoff',
      artifacts: ['claude-code-smoke-worker.js'],
      decisions: ['使用 fake Claude worker 验证 adapter prompt'],
      openQuestions: [],
      risks: [],
      recommendedNextRole: null
    }
  }));
});

function resolveMode(argv) {
  if (argv.includes('--blocked')) {
    return 'blocked';
  }

  if (argv.includes('--transient-api-502-always')) {
    return 'transient-api-502-always';
  }

  const transientStatePath = getFlagValue(argv, '--transient-state-path');
  const transientApi502StatePath = getFlagValue(argv, '--transient-api-502-state-path');
  if (transientStatePath) {
    if (!fs.existsSync(transientStatePath)) {
      fs.writeFileSync(transientStatePath, 'triggered', 'utf8');
      return 'transient-once';
    }
    return 'done-after-transient';
  }

  if (transientApi502StatePath) {
    if (!fs.existsSync(transientApi502StatePath)) {
      fs.writeFileSync(transientApi502StatePath, 'triggered', 'utf8');
      return 'transient-api-502-once';
    }
    return 'done-after-transient-api-502';
  }

  return 'done';
}

function buildSmokePayload({ mode, task, prompt }) {
  return {
    worker: 'claude-code-smoke',
    mode,
    cwd: process.cwd(),
    envWorkspacePath: process.env.WORKFLOW_CLOSURE_CLAUDE_WORKSPACE_PATH || null,
    envDbPath: process.env.WORKFLOW_CLOSURE_CLAUDE_DB_PATH || null,
    taskId: task.taskId || null,
    promptHasTask: prompt.includes(task.title || ''),
    promptRequiresJson: prompt.includes('Return only valid JSON'),
    promptRequiresHandoff: prompt.includes('recommendedNextRole'),
    promptRequiresOutputs: prompt.includes('taskOutputs') && prompt.includes('payload.outputs') && prompt.includes('handoff.artifacts')
  };
}

function getFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }

  return String(value);
}
