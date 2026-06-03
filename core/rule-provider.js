import fs from 'node:fs/promises';
import path from 'node:path';

export function createRuleProvider(handler) {
  if (typeof handler !== 'function') {
    throw new Error('Rule provider handler must be a function.');
  }

  return {
    async getRules(input) {
      const result = await handler(input);
      return normalizeRuleProviderResult(result);
    }
  };
}

const MAX_FILE_SIZE = 100 * 1024 * 1024;

export function createJsonlRuleProvider(options = {}) {
  return createRuleProvider(async (input) => {
    const filePath = resolveFilePath(options.filePath, input);
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`Rule provider file exceeds maximum size of ${MAX_FILE_SIZE} bytes.`);
    }
    const raw = await fs.readFile(filePath, 'utf8');
    const rules = [];
    const lines = raw.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Failed to parse rule provider JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }

      rules.push(parsed);
    }

    return {
      rules,
      metadata: {
        ruleProvider: 'jsonl',
        filePath
      }
    };
  });
}

export function normalizeRuleProviderResult(result) {
  if (result == null) {
    return {
      rules: [],
      metadata: {}
    };
  }

  if (Array.isArray(result)) {
    return {
      rules: normalizeRuleItems(result),
      metadata: {}
    };
  }

  if (typeof result !== 'object') {
    throw new Error('Rule provider must return an object result or rule array.');
  }

  const rules = Array.isArray(result.rules)
    ? result.rules
    : Array.isArray(result.items)
      ? result.items
      : [];

  return {
    rules: normalizeRuleItems(rules),
    metadata: normalizeMetadata(result.metadata)
  };
}

export function resolveRuleProvider(ruleProvider) {
  if (!ruleProvider) {
    return {
      async getRules() {
        return {
          rules: [],
          metadata: {}
        };
      }
    };
  }

  if (typeof ruleProvider?.getRules === 'function') {
    return {
      async getRules(input) {
        return normalizeRuleProviderResult(await ruleProvider.getRules(input));
      }
    };
  }

  if (typeof ruleProvider === 'function') {
    return createRuleProvider(ruleProvider);
  }

  throw new Error('Rule provider must be a function or an object with a getRules() method.');
}

function normalizeRuleItems(items) {
  return items
    .map((item, index) => normalizeRuleItem(item, index))
    .filter(Boolean)
    .sort((left, right) => {
      const priorityDelta = right.priority - left.priority;
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return left.sequence - right.sequence;
    });
}

function normalizeRuleItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('Rule items must be objects.');
  }

  if (item.enabled === false) {
    return null;
  }

  const text = normalizeOptionalText(item.text ?? item.rule ?? item.content ?? item.summary);
  if (!text) {
    throw new Error(`Rule item at index ${index} must include text, rule, content, or summary.`);
  }

  return {
    ruleId: normalizeOptionalText(item.ruleId ?? item.id) || `rule-${index + 1}`,
    title: normalizeOptionalText(item.title),
    text,
    priority: normalizePriority(item.priority),
    metadata: normalizeMetadata(item.metadata),
    sequence: index
  };
}

function resolveFilePath(filePathOption, input) {
  const filePath = normalizeOptionalText(
    resolveOptionValue(filePathOption, input)
    ?? input?.filePath
    ?? input?.path
    ?? input?.sourceRef
  );

  if (!filePath) {
    throw new Error('JSONL rule provider requires a filePath.');
  }

  const resolvedPath = path.resolve(filePath);
  const cwd = process.cwd();

  if (!resolvedPath.startsWith(cwd + path.sep) && resolvedPath !== cwd) {
    throw new Error('Rule provider file path must be within the current working directory.');
  }

  return resolvedPath;
}

function resolveOptionValue(value, input) {
  return typeof value === 'function'
    ? value(input)
    : value;
}

function normalizePriority(value) {
  if (value == null || value === '') {
    return 0;
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error('Rule priority must be a finite number when provided.');
  }

  return normalized;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
