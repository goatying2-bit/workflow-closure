const DEFAULT_PROFILE = 'standard';
const DEFAULT_PACKAGE_MANAGER = 'npm';
const DEFAULT_TIMEOUT_MS = 120_000;

const CATALOG = [
  { pattern: /^runner\/verifier\.js$/, scripts: ['verifier-smoke-test', 'runner-smoke-test'], reason: 'verifier code changed' },
  { pattern: /^runner\/workflow-runner\.js$/, scripts: ['runner-smoke-test', 'cli-smoke-test'], reason: 'workflow runner code changed' },
  { pattern: /^runner\/prompt-builder\.js$/, scripts: ['runner-smoke-test', 'context-smoke-test'], reason: 'prompt builder code changed' },
  { pattern: /^core\/workflow-engine\.js$/, scripts: ['smoke-test', 'cli-smoke-test'], reason: 'workflow engine code changed' },
  { pattern: /^storage\/workflows\.js$/, scripts: ['smoke-test', 'cli-smoke-test'], reason: 'workflow storage code changed' },
  { pattern: /^core\/task-source\.js$/, scripts: ['task-source-smoke-test'], reason: 'task source code changed' },
  { pattern: /^core\/rule-provider\.js$/, scripts: ['rule-provider-smoke-test', 'runner-smoke-test'], reason: 'rule provider code changed' },
  { pattern: /^cli\.js$/, scripts: ['cli-smoke-test', 'agent-contract-smoke-test'], reason: 'CLI code changed' },
  { pattern: /^package\.json$/, scripts: ['verify-agent-contract'], reason: 'package metadata changed' },
  { pattern: /^scripts\/generate-cli-protocol-examples\.js$/, scripts: ['verify-agent-contract'], reason: 'CLI protocol generator changed' },
  { pattern: /^scripts\/generate-agent-integration-contract\.js$/, scripts: ['verify-agent-contract'], reason: 'agent contract generator changed' },
  { pattern: /^generated\//, scripts: ['verify-agent-contract'], reason: 'generated protocol artifacts changed' }
];

export function selectValidationCommands(input = {}) {
  const profile = normalizeProfile(input.profile || input.validationProfile);
  const packageManager = normalizeOptionalText(input.packageManager) || DEFAULT_PACKAGE_MANAGER;
  const cwd = normalizeOptionalText(input.cwd) || null;
  const changedFiles = collectChangedFiles(input);
  const availableScripts = normalizeAvailableScripts(input);
  const selected = [];
  const warnings = [];

  for (const file of changedFiles) {
    const normalizedPath = normalizePath(file);
    const match = CATALOG.find((item) => item.pattern.test(normalizedPath));
    const isUnknownJs = !match && /\.m?js$/.test(normalizedPath);
    const scripts = isUnknownJs ? ['smoke-test'] : match?.scripts || [];
    const reason = isUnknownJs ? 'unknown JavaScript file changed' : match?.reason;
    const selectedScripts = profile === 'minimal' && scripts.length > 0 ? [scripts[0]] : scripts;

    for (const script of selectedScripts) {
      if (availableScripts && !availableScripts.has(script)) {
        warnings.push(`Skipped missing package script "${script}" for ${normalizedPath}.`);
        continue;
      }

      selected.push(buildCommand({
        script,
        packageManager,
        cwd,
        reason: reason ? `${reason}: ${normalizedPath}` : `changed file: ${normalizedPath}`
      }));
    }
  }

  if (profile === 'comprehensive' && (!availableScripts || availableScripts.has('full-smoke-test'))) {
    selected.push(buildCommand({
      script: 'full-smoke-test',
      packageManager,
      cwd,
      reason: 'comprehensive validation requested',
      timeoutMs: 600_000
    }));
  }

  const commands = dedupeCommands(selected).map(normalizeValidationCommand);

  if (changedFiles.length === 0) {
    warnings.push('No changedFiles were provided; no validation commands were selected.');
  }

  return {
    profile,
    commands,
    warnings
  };
}

export function normalizeValidationCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('Validation command must be an object.');
  }

  const normalizedCommand = normalizeOptionalText(command.command);
  const script = normalizeOptionalText(command.script);
  const args = normalizeStringArray(command.args);
  if (!normalizedCommand) {
    throw new Error('Validation command requires command.');
  }
  if (args.length === 0 && !script) {
    throw new Error('Validation command requires args or script.');
  }

  return {
    id: normalizeOptionalText(command.id) || buildCommandId(script || [normalizedCommand, ...args].join('-')),
    command: normalizedCommand,
    args: args.length > 0 ? args : ['run', script],
    script,
    cwd: normalizeOptionalText(command.cwd),
    reason: normalizeOptionalText(command.reason) || 'validation command selected',
    required: command.required !== false,
    timeoutMs: normalizeTimeoutMs(command.timeoutMs)
  };
}

function collectChangedFiles(input) {
  return dedupeStrings([
    ...normalizeStringArray(input.changedFiles),
    ...normalizeStringArray(input.targetFiles),
    ...normalizeStringArray(input.task?.changedFiles),
    ...normalizeStringArray(input.task?.targetFiles),
    ...normalizeStringArray(input.task?.handoff?.artifacts),
    ...normalizeStringArray(input.workflow?.changedFiles),
    ...normalizeStringArray(input.workflow?.targetFiles)
  ]);
}

function normalizeAvailableScripts(input) {
  const scripts = input.packageScripts ?? input.packageJson?.scripts;
  if (scripts == null) {
    return null;
  }

  if (Array.isArray(scripts)) {
    return new Set(normalizeStringArray(scripts));
  }

  if (typeof scripts === 'object') {
    return new Set(Object.keys(scripts).map((item) => normalizeOptionalText(item)).filter(Boolean));
  }

  throw new Error('packageScripts must be an object or array when provided.');
}

function buildCommand({ script, packageManager, cwd, reason, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return {
    id: buildCommandId(script),
    command: packageManager,
    args: ['run', script],
    script,
    cwd,
    reason,
    required: true,
    timeoutMs
  };
}

function dedupeCommands(commands) {
  const seen = new Set();
  const output = [];

  for (const command of commands) {
    const key = `${command.cwd || ''}\0${command.command}\0${command.args.join('\0')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(command);
  }

  return output;
}

function normalizeProfile(value) {
  const profile = normalizeOptionalText(value) || DEFAULT_PROFILE;
  if (!['minimal', 'standard', 'comprehensive'].includes(profile)) {
    throw new Error(`Unsupported validation profile: ${profile}`);
  }
  return profile;
}

function normalizePath(value) {
  return normalizeOptionalText(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function buildCommandId(value) {
  return normalizeOptionalText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'validation-command';
}

function normalizeTimeoutMs(value) {
  if (value == null) {
    return DEFAULT_TIMEOUT_MS;
  }

  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Validation command timeoutMs must be a non-negative number.');
  }
  return Math.floor(timeoutMs);
}

function normalizeStringArray(value) {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeOptionalText(item)).filter(Boolean);
  }

  const text = normalizeOptionalText(value);
  return text ? [text] : [];
}

function dedupeStrings(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const text = normalizeOptionalText(item);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    output.push(text);
  }

  return output;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
