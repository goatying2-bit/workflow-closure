import { selectValidationCommands } from './validation-selector.js';

const PLANNER_MODES = new Set(['fix', 'feature', 'refactor', 'test']);
const CLOSURE_MODES = new Set(['small_loop', 'large_loop']);
const VERIFICATION_LEVELS = new Set(['targeted', 'broad']);
const DOC_POLICIES = new Set(['minimal', 'required']);
const CLEANUP_POLICIES = new Set(['defer', 'explicit_only']);

export function draftCodingPlan(input = {}) {
  const instruction = requireText(input.instruction, 'instruction');
  const mode = normalizePlannerMode(input.plannerMode || input.mode, instruction);
  const goal = normalizeOptionalText(input.goal) || buildGoal(instruction, mode);
  const changedFiles = dedupeStrings(normalizeStringArray(input.changedFiles));
  const targetFiles = dedupeStrings(normalizeStringArray(input.targetFiles));
  const validation = selectValidationCommands({
    changedFiles: changedFiles.length > 0 ? changedFiles : targetFiles,
    cwd: input.cwd,
    packageScripts: input.packageScripts,
    packageJson: input.packageJson,
    packageManager: input.packageManager,
    profile: input.validationProfile || input.profile
  });
  const scopeFiles = changedFiles.length > 0 ? changedFiles : targetFiles;
  const validationCommands = validation.commands;
  const repairLoop = normalizeOptionalBoolean(input.repairLoop) === true;
  const maxRepairAttempts = repairLoop ? normalizeMaxRepairAttempts(input.maxRepairAttempts) : null;
  const closurePolicy = resolveClosurePolicy({
    instruction,
    mode,
    changedFiles,
    targetFiles,
    scopeFiles,
    validation
  });
  const steps = [
    buildInspectStep({ mode, scopeFiles }),
    buildImplementStep({ mode, scopeFiles }),
    buildValidationSelectionStep({ validation, scopeFiles }),
    buildValidationRunStep({ validationCommands })
  ];
  const dependencies = [
    { predecessor: 'inspect-scope', successor: 'implement-change' },
    { predecessor: 'implement-change', successor: 'select-validation' },
    { predecessor: 'select-validation', successor: 'run-validation' }
  ];

  if (repairLoop) {
    steps.push(
      buildRepairValidationFailureStep({ scopeFiles, maxRepairAttempts }),
      buildRerunValidationStep({ validationCommands })
    );
    dependencies.push(
      {
        predecessor: 'run-validation',
        successor: 'repair-validation-failure',
        condition: failedValidationCondition()
      },
      { predecessor: 'repair-validation-failure', successor: 'rerun-validation-after-repair' }
    );
  }

  return {
    goal,
    category: 'coding',
    instruction,
    steps,
    dependencies,
    assumptions: buildAssumptions({ scopeFiles, validation, repairLoop }),
    risks: buildRisks({ scopeFiles, validation, repairLoop }),
    metadata: {
      planner: 'coding-planner',
      plannerMode: mode,
      changedFiles,
      targetFiles,
      validationProfile: validation.profile,
      validationWarnings: validation.warnings,
      repairLoop,
      maxRepairAttempts,
      ...closurePolicy
    }
  };
}

function resolveClosurePolicy({ instruction, mode, changedFiles, targetFiles, scopeFiles, validation }) {
  const closureMode = classifyClosureMode({
    instruction,
    mode,
    changedFiles,
    targetFiles,
    scopeFiles,
    validation
  });

  return {
    closureMode,
    verificationLevel: closureMode === 'large_loop' ? 'broad' : 'targeted',
    docPolicy: closureMode === 'large_loop' ? 'required' : 'minimal',
    cleanupPolicy: closureMode === 'large_loop' ? 'explicit_only' : 'defer'
  };
}

function classifyClosureMode({ instruction, mode, changedFiles, targetFiles, scopeFiles, validation }) {
  const text = instruction.toLowerCase();
  const files = dedupeStrings([...changedFiles, ...targetFiles, ...scopeFiles]);
  const warnings = Array.isArray(validation?.warnings) ? validation.warnings : [];
  const commands = Array.isArray(validation?.commands) ? validation.commands : [];

  if (mode === 'refactor') {
    return 'large_loop';
  }

  if (files.length >= 4) {
    return 'large_loop';
  }

  if (commands.length >= 3) {
    return 'large_loop';
  }

  if (warnings.length >= 2) {
    return 'large_loop';
  }

  if (/(cross-cutting|cross cutting|system-wide|end-to-end|e2e|integration|migration|schema|api contract|breaking change|跨模块|跨边界|全链路|端到端|迁移|数据库|协议)/.test(text)) {
    return 'large_loop';
  }

  return 'small_loop';
}

function buildInspectStep({ mode, scopeFiles }) {
  return {
    key: 'inspect-scope',
    title: 'Inspect affected coding scope',
    description: [
      'Read the relevant files and existing patterns before changing code.',
      `Planner mode: ${mode}.`,
      formatScopeFiles(scopeFiles)
    ].filter(Boolean).join('\n'),
    sequence: 0,
    type: 'research',
    preferredRole: 'researcher',
    requiredCapabilities: ['codebase-inspection'],
    contract: {
      successCriteria: ['Identify affected files, existing patterns, and implementation constraints.'],
      requiredArtifacts: ['affected-scope-summary'],
      forbiddenActions: ['modify-files'],
      assumptionsPolicy: 'allow_reasonable_assumptions'
    },
    handoff: {
      summary: 'Coding scope inspection should hand off affected files and constraints.',
      artifacts: scopeFiles,
      recommendedNextRole: 'implementer'
    }
  };
}

function buildImplementStep({ mode, scopeFiles }) {
  return {
    key: 'implement-change',
    title: 'Implement focused coding change',
    description: [
      'Make the smallest code change that satisfies the instruction and upstream scope notes.',
      `Planner mode: ${mode}.`,
      formatScopeFiles(scopeFiles)
    ].filter(Boolean).join('\n'),
    sequence: 1,
    type: 'implement',
    preferredRole: 'implementer',
    requiredCapabilities: ['code-editing'],
    contract: {
      successCriteria: ['The requested coding change is implemented without unrelated refactors.'],
      requiredArtifacts: ['changed-files'],
      forbiddenActions: ['unrelated-refactor', 'destructive-git-operation'],
      assumptionsPolicy: 'block_on_missing_information'
    },
    handoff: {
      summary: 'Implementation should hand off changed files, decisions, and risks.',
      artifacts: scopeFiles,
      recommendedNextRole: 'reviewer'
    }
  };
}

function buildValidationSelectionStep({ validation, scopeFiles }) {
  return {
    key: 'select-validation',
    title: 'Select targeted validation commands',
    description: [
      'Confirm or refine the validation commands based on the final changed files.',
      formatScopeFiles(scopeFiles),
      validation.commands.length > 0 ? `Initial commands: ${validation.commands.map(formatCommand).join('；')}` : 'Initial commands: none selected.'
    ].filter(Boolean).join('\n'),
    sequence: 2,
    type: 'verify',
    preferredRole: 'reviewer',
    requiredCapabilities: ['test-selection'],
    contract: {
      successCriteria: ['Validation commands are selected and justified for the changed files.'],
      requiredArtifacts: ['validation-plan'],
      assumptionsPolicy: 'allow_reasonable_assumptions',
      validationCommands: validation.commands
    },
    handoff: {
      summary: 'Validation selection should hand off commands and reasons.',
      artifacts: validation.commands.map(formatCommand),
      risks: validation.warnings,
      recommendedNextRole: 'reviewer'
    }
  };
}

function buildValidationRunStep({ validationCommands }) {
  return {
    key: 'run-validation',
    title: 'Run validation and fix failures',
    description: validationCommands.length > 0
      ? `Run required validation commands and address failures: ${validationCommands.map(formatCommand).join('；')}`
      : 'No validation commands were selected automatically; explain what validation is missing or blocked.',
    sequence: 3,
    type: 'verify',
    preferredRole: 'reviewer',
    requiredCapabilities: ['test-execution', 'failure-analysis'],
    contract: {
      successCriteria: ['Required validation passes, or blocking validation gaps are clearly reported.'],
      requiredArtifacts: ['validation-results'],
      assumptionsPolicy: validationCommands.length > 0 ? 'allow_reasonable_assumptions' : 'block_on_missing_information',
      validationCommands
    },
    handoff: {
      summary: 'Validation run should hand off pass/fail evidence and any remaining risks.',
      artifacts: validationCommands.map(formatCommand)
    }
  };
}

function buildRepairValidationFailureStep({ scopeFiles, maxRepairAttempts }) {
  return {
    key: 'repair-validation-failure',
    title: 'Repair validation failure',
    description: [
      'Consume failed validation-result evidence from the validation task and make the smallest focused fix.',
      'Do not bypass validation or introduce unrelated refactors.',
      `Max repair attempts: ${maxRepairAttempts}.`,
      formatScopeFiles(scopeFiles)
    ].filter(Boolean).join('\n'),
    sequence: 4,
    type: 'implement',
    preferredRole: 'implementer',
    requiredCapabilities: ['code-editing', 'failure-analysis'],
    contract: {
      successCriteria: ['The failed validation evidence is addressed with the smallest focused code change.'],
      requiredArtifacts: ['changed-files', 'repair-summary'],
      forbiddenActions: ['bypass-validation', 'unrelated-refactor', 'destructive-git-operation'],
      assumptionsPolicy: 'block_on_missing_information',
      repairOf: 'validation-result',
      consumeOutputKind: 'validation-result',
      consumeOutputName: 'validation-commands',
      maxRepairAttempts
    },
    handoff: {
      summary: 'Repair should hand off changed files, failure cause, and fix rationale.',
      artifacts: scopeFiles,
      recommendedNextRole: 'reviewer'
    }
  };
}

function buildRerunValidationStep({ validationCommands }) {
  return {
    key: 'rerun-validation-after-repair',
    title: 'Rerun validation after repair',
    description: validationCommands.length > 0
      ? `Rerun required validation commands after the repair: ${validationCommands.map(formatCommand).join('；')}`
      : 'No validation commands were selected automatically; explain what validation is missing or blocked after repair.',
    sequence: 5,
    type: 'verify',
    preferredRole: 'reviewer',
    requiredCapabilities: ['test-execution', 'failure-analysis'],
    contract: {
      successCriteria: ['Required validation passes after repair, or remaining validation gaps are clearly reported.'],
      requiredArtifacts: ['validation-results'],
      assumptionsPolicy: validationCommands.length > 0 ? 'allow_reasonable_assumptions' : 'block_on_missing_information',
      validationCommands
    },
    handoff: {
      summary: 'Post-repair validation should hand off pass/fail evidence and any remaining risks.',
      artifacts: validationCommands.map(formatCommand)
    }
  };
}

function failedValidationCondition() {
  return {
    outputKind: 'validation-result',
    outputName: 'validation-commands',
    path: 'metadata.trustState',
    operator: 'equals',
    value: 'failed'
  };
}

function buildAssumptions({ scopeFiles, validation, repairLoop }) {
  const assumptions = ['Coding workflow uses explicit changedFiles/targetFiles when provided; it does not inspect git state.'];
  if (scopeFiles.length === 0) {
    assumptions.push('Affected files are unknown and must be discovered during scope inspection.');
  }
  if (validation.warnings.length > 0) {
    assumptions.push('Some validation scripts may be unavailable in the supplied package scripts.');
  }
  if (repairLoop) {
    assumptions.push('Repair-loop mode advances failed validation only into the explicit repair branch.');
  }
  return assumptions;
}

function buildRisks({ scopeFiles, validation, repairLoop }) {
  const risks = [];
  if (scopeFiles.length === 0) {
    risks.push('Without explicit files, validation selection may be incomplete until implementation reports changed files.');
  }
  if (validation.commands.length === 0) {
    risks.push('No validation command was selected automatically.');
  }
  if (repairLoop) {
    risks.push('Repair-loop branch does not merge with an initial successful validation path in this static plan.');
  }
  risks.push(...validation.warnings);
  return risks;
}

function normalizePlannerMode(value, instruction) {
  const explicit = normalizeOptionalText(value)?.toLowerCase();
  if (explicit) {
    if (!PLANNER_MODES.has(explicit)) {
      throw new Error(`Unsupported plannerMode: ${explicit}`);
    }
    return explicit;
  }

  const text = instruction.toLowerCase();
  if (/fix|bug|error|issue|repair|修复|报错|异常|故障/.test(text)) {
    return 'fix';
  }
  if (/refactor|cleanup|restructure|重构|整理|收敛/.test(text)) {
    return 'refactor';
  }
  if (/test|verify|验证|测试/.test(text)) {
    return 'test';
  }
  return 'feature';
}

function normalizeClosureMode(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return 'small_loop';
  }
  if (!CLOSURE_MODES.has(normalized)) {
    throw new Error(`Unsupported closureMode: ${normalized}`);
  }
  return normalized;
}

function normalizeVerificationLevel(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return 'targeted';
  }
  if (!VERIFICATION_LEVELS.has(normalized)) {
    throw new Error(`Unsupported verificationLevel: ${normalized}`);
  }
  return normalized;
}

function normalizeDocPolicy(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return 'minimal';
  }
  if (!DOC_POLICIES.has(normalized)) {
    throw new Error(`Unsupported docPolicy: ${normalized}`);
  }
  return normalized;
}

function normalizeCleanupPolicy(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return 'defer';
  }
  if (!CLEANUP_POLICIES.has(normalized)) {
    throw new Error(`Unsupported cleanupPolicy: ${normalized}`);
  }
  return normalized;
}

function buildGoal(instruction, mode) {
  return `Complete ${mode} coding workflow: ${instruction}`;
}

function formatScopeFiles(files) {
  return files.length > 0 ? `Known files: ${files.join(', ')}.` : null;
}

function formatCommand(command) {
  return `${command.command} ${command.args.join(' ')}${command.reason ? ` (${command.reason})` : ''}`;
}

function requireText(value, label) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
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
  return [...new Set(items)];
}

function normalizeMaxRepairAttempts(value) {
  if (value == null || value === '') {
    return 1;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    throw new Error('maxRepairAttempts must be a positive number.');
  }

  return Math.floor(number);
}

function normalizeOptionalBoolean(value) {
  if (value == null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 1 || value === '1' || value === 'true') {
    return true;
  }

  if (value === 0 || value === '0' || value === 'false') {
    return false;
  }

  throw new Error('repairLoop must be a boolean.');
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}
