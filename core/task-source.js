import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const PLACEHOLDER_DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx', '.pdf', '.ppt', '.pptx']);
const SUPPORTED_FILE_EXTENSIONS = ['.json', ...PLACEHOLDER_DOCUMENT_EXTENSIONS];

export function createTaskSource(handler) {
  if (typeof handler !== 'function') {
    throw new Error('Task source handler must be a function.');
  }

  return {
    async load(input) {
      const result = await handler(input);
      return normalizeTaskSourceResult(result);
    }
  };
}

export function createFileTaskSource(options = {}) {
  return createTaskSource(async (input) => {
    const filePath = resolveFilePath(options.filePath, input, { label: 'File task source' });
    const stats = await readTaskSourceFileStats(filePath);
    const fileExtension = normalizeFileExtension(filePath);

    if (fileExtension === '.json') {
      return loadJsonTaskSourceFile(filePath, stats);
    }

    if (PLACEHOLDER_DOCUMENT_EXTENSIONS.has(fileExtension)) {
      return buildPlaceholderDocumentTaskSourceResult({ filePath, fileExtension, stats, input });
    }

    throw new Error(
      `Unsupported task source file extension: ${fileExtension || '(none)'}. Supported extensions: ${SUPPORTED_FILE_EXTENSIONS.join(', ')}`
    );
  });
}

export function createJsonTaskSource(options = {}) {
  return createTaskSource(async (input) => {
    const filePath = resolveFilePath(options.filePath, input, { label: 'JSON task source' });
    const stats = await readTaskSourceFileStats(filePath);
    const fileExtension = normalizeFileExtension(filePath);

    if (fileExtension !== '.json') {
      throw new Error(`JSON task source requires a .json file, received ${fileExtension || '(none)'}.`);
    }

    return loadJsonTaskSourceFile(filePath, stats);
  });
}

export function normalizeTaskSourceResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Task source must return an object result.');
  }

  const plan = result.plan ?? (Array.isArray(result.steps) ? result : null);
  const instruction = normalizeOptionalText(
    result.instruction
    ?? result.task
    ?? result.prompt
    ?? result.goal
    ?? plan?.instruction
    ?? plan?.goal
  );

  if (!instruction) {
    throw new Error('Task source result must include instruction, goal, or plan.goal.');
  }

  return {
    workflowId: normalizeOptionalText(result.workflowId),
    instruction,
    goal: normalizeOptionalText(result.goal ?? plan?.goal),
    plan: plan ?? null,
    metadata: normalizeMetadata(result.metadata)
  };
}

export function resolveTaskSource(taskSource) {
  if (typeof taskSource?.load === 'function') {
    return {
      async load(input) {
        return normalizeTaskSourceResult(await taskSource.load(input));
      }
    };
  }

  if (typeof taskSource === 'function') {
    return createTaskSource(taskSource);
  }

  throw new Error('Task source must be a function or an object with a load() method.');
}

function resolveFilePath(filePathOption, input, options = {}) {
  const filePath = normalizeOptionalText(
    resolveOptionValue(filePathOption, input)
    ?? input?.filePath
    ?? input?.path
    ?? input?.sourceRef
  );

  if (!filePath) {
    throw new Error(`${options.label || 'Task source'} requires a filePath.`);
  }

  const resolvedPath = path.resolve(filePath);
  const cwd = process.cwd();

  if (!resolvedPath.startsWith(cwd + path.sep) && resolvedPath !== cwd) {
    throw new Error('Task source file path must be within the current working directory.');
  }

  return resolvedPath;
}

async function readTaskSourceFileStats(filePath) {
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(`Task source file exceeds maximum size of ${MAX_FILE_SIZE} bytes.`);
  }
  return stats;
}

async function loadJsonTaskSourceFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse task source JSON at ${filePath}: ${error.message}`);
  }

  const payload = unwrapPayload(parsed);
  const plan = payload.plan ?? (Array.isArray(payload.steps) ? payload : null);
  const fileExtension = normalizeFileExtension(filePath);

  return {
    workflowId: payload.workflowId,
    instruction: payload.instruction,
    goal: payload.goal,
    plan,
    metadata: {
      ...normalizeMetadata(payload.metadata),
      taskSource: 'json',
      filePath,
      fileExtension
    }
  };
}

function buildPlaceholderDocumentTaskSourceResult({ filePath, fileExtension, stats, input }) {
  const fileName = path.basename(filePath);
  const instruction = normalizeOptionalText(input?.instruction)
    ?? `从文档 ${fileName} 导入占位工作流`;
  const goal = normalizeOptionalText(input?.goal)
    ?? `审阅文档 ${fileName} 并整理可执行任务`;

  return {
    instruction,
    goal,
    plan: input?.plan ?? {
      goal,
      steps: [
        {
          key: 'review-source-document',
          title: '检查源文档',
          description: `源文件 ${fileName} (${fileExtension}) 当前以 placeholder 模式导入。请人工查看原文并整理为后续 workflow 任务。`
        }
      ],
      dependencies: []
    },
    metadata: {
      taskSource: 'document-placeholder',
      filePath,
      fileName,
      fileExtension,
      fileSize: stats.size,
      parseMode: 'placeholder'
    }
  };
}

function normalizeFileExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function unwrapPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task source JSON must contain an object.');
  }

  if (value.workflow && typeof value.workflow === 'object' && !Array.isArray(value.workflow)) {
    return value.workflow;
  }

  if (value.taskSource && typeof value.taskSource === 'object' && !Array.isArray(value.taskSource)) {
    return value.taskSource;
  }

  return value;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function resolveOptionValue(value, input) {
  return typeof value === 'function'
    ? value(input)
    : value;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
