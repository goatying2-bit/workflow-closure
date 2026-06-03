import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, normalizeWorkspacePath, resolveDbPath } from './db.js';

const MEMORY_STATUSES = new Set(['active', 'stale', 'superseded', 'archived']);
const DEFAULT_RECALL_STATUSES = Object.freeze(['active']);
const MEMORY_COLUMNS = `
  memory_id,
  type,
  scope,
  project_key,
  workspace_path,
  session_id,
  title,
  summary,
  content,
  status,
  confidence,
  stability,
  source_kind,
  source_ref,
  subject_kind,
  subject_ref,
  workflow_id,
  task_id,
  event_kind,
  structure_json,
  content_hash,
  created_at,
  updated_at,
  last_recalled_at
`;
const TAG_COLUMNS = 'memory_id, tag, created_at';
const LINK_COLUMNS = 'link_id, source_memory_id, target_memory_id, relation, created_at';
const EVENT_COLUMNS = 'event_id, memory_id, action, message, payload_json, created_at';
const DEFAULT_SEMANTIC_CANDIDATE_LIMIT = 12;
const DEFAULT_SEMANTIC_WEIGHT = 0.2;
const DEFAULT_SEMANTIC_MODEL_KEY = 'default';
const QUALIFIED_MEMORY_COLUMNS = MEMORY_COLUMNS
  .split(',')
  .map((column) => column.trim())
  .filter(Boolean)
  .map((column) => `mr.${column}`)
  .join(',\n  ');

export async function initializeMemoryStore(options = {}) {
  const dbPath = resolveDbPath(options);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const database = getDb(dbPath);

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_records (
      memory_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_key TEXT,
      workspace_path TEXT,
      session_id TEXT,
      title TEXT,
      summary TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL,
      stability TEXT,
      source_kind TEXT,
      source_ref TEXT,
      subject_kind TEXT,
      subject_ref TEXT,
      workflow_id TEXT,
      task_id TEXT,
      event_kind TEXT,
      structure_json TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_recalled_at TEXT
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag),
      FOREIGN KEY (memory_id) REFERENCES memory_records (memory_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_links (
      link_id TEXT PRIMARY KEY,
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (source_memory_id, target_memory_id, relation),
      FOREIGN KEY (source_memory_id) REFERENCES memory_records (memory_id) ON DELETE CASCADE,
      FOREIGN KEY (target_memory_id) REFERENCES memory_records (memory_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_events (
      event_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memory_records (memory_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT NOT NULL,
      model_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, model_key),
      FOREIGN KEY (memory_id) REFERENCES memory_records (memory_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED,
      title,
      summary,
      content
    )
  `);

  ensureColumn(database, 'memory_records', 'project_key', 'TEXT');
  ensureColumn(database, 'memory_records', 'workspace_path', 'TEXT');
  ensureColumn(database, 'memory_records', 'session_id', 'TEXT');
  ensureColumn(database, 'memory_records', 'title', 'TEXT');
  ensureColumn(database, 'memory_records', 'summary', 'TEXT');
  ensureColumn(database, 'memory_records', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(database, 'memory_records', 'confidence', 'REAL');
  ensureColumn(database, 'memory_records', 'stability', 'TEXT');
  ensureColumn(database, 'memory_records', 'source_kind', 'TEXT');
  ensureColumn(database, 'memory_records', 'source_ref', 'TEXT');
  ensureColumn(database, 'memory_records', 'subject_kind', 'TEXT');
  ensureColumn(database, 'memory_records', 'subject_ref', 'TEXT');
  ensureColumn(database, 'memory_records', 'workflow_id', 'TEXT');
  ensureColumn(database, 'memory_records', 'task_id', 'TEXT');
  ensureColumn(database, 'memory_records', 'event_kind', 'TEXT');
  ensureColumn(database, 'memory_records', 'structure_json', 'TEXT');
  ensureColumn(database, 'memory_records', 'content_hash', 'TEXT');
  ensureColumn(database, 'memory_records', 'last_recalled_at', 'TEXT');
  ensureColumn(database, 'memory_events', 'payload_json', 'TEXT');

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_status_scope_type
    ON memory_records (status, scope, type, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_project
    ON memory_records (project_key, workspace_path, session_id, updated_at)
  `);


  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_confidence
    ON memory_records (status, confidence, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_subject
    ON memory_records (scope, subject_kind, subject_ref, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_workflow_task
    ON memory_records (scope, workflow_id, task_id, event_kind, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag
    ON memory_tags (tag, memory_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_links_source
    ON memory_links (source_memory_id, relation, target_memory_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_links_target
    ON memory_links (target_memory_id, relation, source_memory_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_events_memory_created
    ON memory_events (memory_id, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model_updated
    ON memory_embeddings (model_key, updated_at, memory_id)
  `);

  return database;
}

export function getMemoryStore(options = {}) {
  const database = getDb(resolveDbPath(options));
  const semanticOptions = normalizeSemanticOptions(options.semantic || options.memory?.semantic);
  const defaultBoundary = resolveRecallBoundaryDefaults(options);

  return {
    database,
    createMemory(input) {
      return createMemory(database, input);
    },
    getMemory(memoryId) {
      return getMemory(database, memoryId);
    },
    listMemoryTags(memoryId) {
      return listMemoryTags(database, memoryId);
    },
    listMemoryLinks(memoryId) {
      return listMemoryLinks(database, memoryId);
    },
    listMemoryEvents(memoryId, query = {}) {
      return listMemoryEvents(database, memoryId, query);
    },
    updateMemory(input) {
      return updateMemory(database, input);
    },
    archiveMemory(input) {
      return archiveMemory(database, input);
    },
    recall(query = {}) {
      return recallMemories(database, applyRecallBoundaryDefaults(query, defaultBoundary), semanticOptions);
    },
    getMemoryState(memoryId, query = {}) {
      return getMemoryState(database, memoryId, query);
    }
  };
}

function resolveRecallBoundaryDefaults(options = {}) {
  const memoryOptions = normalizeMemoryOptions(options.memory);

  return {
    scope: normalizeOptionalText(memoryOptions?.scope) || normalizeOptionalText(options.scope),
    projectKey: normalizeOptionalText(memoryOptions?.projectKey) || normalizeOptionalText(options.projectKey),
    workspacePath: normalizeWorkspacePath(memoryOptions?.workspacePath ?? options.workspacePath),
    sessionId: normalizeOptionalText(memoryOptions?.sessionId) || normalizeOptionalText(options.sessionId)
  };
}

function applyRecallBoundaryDefaults(query, defaultBoundary = {}) {
  if (!query || typeof query !== 'object') {
    return query;
  }

  const output = { ...query };

  if (!hasOwn(output, 'scope') && defaultBoundary.scope != null) {
    output.scope = defaultBoundary.scope;
  }

  if (!hasOwn(output, 'projectKey') && defaultBoundary.projectKey != null) {
    output.projectKey = defaultBoundary.projectKey;
  }

  if (!hasOwn(output, 'workspacePath') && defaultBoundary.workspacePath != null) {
    output.workspacePath = defaultBoundary.workspacePath;
  }

  if (!hasOwn(output, 'sessionId') && defaultBoundary.sessionId != null) {
    output.sessionId = defaultBoundary.sessionId;
  }

  return output;
}

function createMemory(database, input = {}) {
  const memoryId = input.memoryId || crypto.randomUUID();
  const type = normalizeRequiredText(input.type, 'Memory type');
  const scope = normalizeRequiredText(input.scope, 'Memory scope');
  const content = normalizeRequiredText(input.content, 'Memory content');
  const title = normalizeOptionalText(input.title);
  const summary = normalizeOptionalText(input.summary);
  const status = normalizeMemoryStatus(input.status || 'active');
  const projectKey = normalizeOptionalText(input.projectKey);
  const workspacePath = normalizeWorkspacePath(input.workspacePath);
  const sessionId = normalizeOptionalText(input.sessionId);
  const confidence = normalizeOptionalNumber(input.confidence, 'confidence') ?? 0.5;
  const stability = normalizeOptionalText(input.stability);
  const sourceKind = normalizeOptionalText(input.sourceKind);
  const sourceRef = normalizeOptionalText(input.sourceRef);
  const subjectKind = normalizeOptionalText(input.subjectKind);
  const subjectRef = normalizeOptionalText(input.subjectRef);
  const workflowId = normalizeOptionalText(input.workflowId);
  const taskId = normalizeOptionalText(input.taskId);
  const eventKind = normalizeOptionalText(input.eventKind);
  const structureJson = normalizeOptionalStructuredValue(
    hasOwn(input, 'structureJson') ? input.structureJson : input.structure,
    input.structureValidation || {}
  );
  const tags = normalizeTags(input.tags);
  const links = normalizeLinks(input.links);

  const existing = database.prepare(`
    SELECT memory_id FROM memory_records WHERE memory_id = ?
  `).get(memoryId);
  if (existing) {
    throw new Error(`Memory "${memoryId}" already exists.`);
  }

  const insertMemory = database.transaction(() => {
    const now = createTimestamp();
    const contentHash = createContentHash({ title, summary, content });

    database.prepare(`
      INSERT INTO memory_records (
        memory_id,
        type,
        scope,
        project_key,
        workspace_path,
        session_id,
        title,
        summary,
        content,
        status,
        confidence,
        stability,
        source_kind,
        source_ref,
        subject_kind,
        subject_ref,
        workflow_id,
        task_id,
        event_kind,
        structure_json,
        content_hash,
        created_at,
        updated_at,
        last_recalled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryId,
      type,
      scope,
      projectKey,
      workspacePath,
      sessionId,
      title,
      summary,
      content,
      status,
      confidence,
      stability,
      sourceKind,
      sourceRef,
      subjectKind,
      subjectRef,
      workflowId,
      taskId,
      eventKind,
      structureJson,
      contentHash,
      now,
      now,
      null
    );

    replaceMemoryTagsSync(database, memoryId, tags, now);
    const insertedLinks = insertMemoryLinksSync(database, memoryId, links, now);
    upsertMemoryFtsSync(database, {
      memoryId,
      title,
      summary,
      content
    });

    const createdEvent = insertMemoryEventSync(database, {
      memoryId,
      action: 'created',
      message: 'Created memory.',
      payload: {
        status,
        type,
        scope,
        tagCount: tags.length,
        linkCount: insertedLinks.length,
        subjectKind,
        subjectRef,
        workflowId,
        taskId,
        eventKind,
        hasStructure: structureJson != null
      },
      createdAt: now
    });

    return {
      memory: requireMemory(database, memoryId),
      events: [createdEvent],
      links: listMemoryLinks(database, memoryId)
    };
  });

  return insertMemory();
}

function getMemory(database, memoryId) {
  const row = database.prepare(`
    SELECT ${MEMORY_COLUMNS}
    FROM memory_records
    WHERE memory_id = ?
    LIMIT 1
  `).get(memoryId);

  return mapMemoryRow(row);
}

function listMemoryTags(database, memoryId) {
  requireMemory(database, memoryId);

  return database.prepare(`
    SELECT ${TAG_COLUMNS}
    FROM memory_tags
    WHERE memory_id = ?
    ORDER BY tag ASC
  `).all(memoryId).map(mapTagRow);
}

function listMemoryLinks(database, memoryId) {
  requireMemory(database, memoryId);

  return database.prepare(`
    SELECT ${LINK_COLUMNS}
    FROM memory_links
    WHERE source_memory_id = ?
       OR target_memory_id = ?
    ORDER BY created_at ASC, link_id ASC
  `).all(memoryId, memoryId).map((row) => mapLinkRow(row, memoryId));
}

function listMemoryEvents(database, memoryId, query = {}) {
  requireMemory(database, memoryId);
  const limit = normalizeOptionalPositiveInteger(query.limit, 'limit') || 100;

  return database.prepare(`
    SELECT ${EVENT_COLUMNS}
    FROM memory_events
    WHERE memory_id = ?
    ORDER BY created_at ASC, event_id ASC
    LIMIT ?
  `).all(memoryId, limit).map(mapEventRow);
}

function updateMemory(database, input = {}) {
  const memoryId = normalizeRequiredText(input.memoryId, 'Memory id');

  const applyUpdate = database.transaction(() => {
    const memory = requireMemory(database, memoryId);
    const now = createTimestamp();
    const changes = {};

    if (hasOwn(input, 'type')) {
      changes.type = normalizeRequiredText(input.type, 'Memory type');
    }

    if (hasOwn(input, 'scope')) {
      changes.scope = normalizeRequiredText(input.scope, 'Memory scope');
    }

    if (hasOwn(input, 'title')) {
      changes.title = normalizeOptionalText(input.title);
    }

    if (hasOwn(input, 'summary')) {
      changes.summary = normalizeOptionalText(input.summary);
    }

    if (hasOwn(input, 'content')) {
      changes.content = normalizeRequiredText(input.content, 'Memory content');
    }

    if (hasOwn(input, 'status')) {
      changes.status = normalizeMemoryStatus(input.status);
    }

    if (hasOwn(input, 'projectKey')) {
      changes.projectKey = normalizeOptionalText(input.projectKey);
    }

    if (hasOwn(input, 'workspacePath')) {
      changes.workspacePath = normalizeWorkspacePath(input.workspacePath);
    }

    if (hasOwn(input, 'sessionId')) {
      changes.sessionId = normalizeOptionalText(input.sessionId);
    }

    if (hasOwn(input, 'confidence')) {
      changes.confidence = normalizeOptionalNumber(input.confidence, 'confidence');
    }

    if (hasOwn(input, 'stability')) {
      changes.stability = normalizeOptionalText(input.stability);
    }

    if (hasOwn(input, 'sourceKind')) {
      changes.sourceKind = normalizeOptionalText(input.sourceKind);
    }

    if (hasOwn(input, 'sourceRef')) {
      changes.sourceRef = normalizeOptionalText(input.sourceRef);
    }

    if (hasOwn(input, 'subjectKind')) {
      changes.subjectKind = normalizeOptionalText(input.subjectKind);
    }

    if (hasOwn(input, 'subjectRef')) {
      changes.subjectRef = normalizeOptionalText(input.subjectRef);
    }

    if (hasOwn(input, 'workflowId')) {
      changes.workflowId = normalizeOptionalText(input.workflowId);
    }

    if (hasOwn(input, 'taskId')) {
      changes.taskId = normalizeOptionalText(input.taskId);
    }

    if (hasOwn(input, 'eventKind')) {
      changes.eventKind = normalizeOptionalText(input.eventKind);
    }

    if (hasOwn(input, 'structureJson') || hasOwn(input, 'structure')) {
      changes.structureJson = normalizeOptionalStructuredValue(
        hasOwn(input, 'structureJson') ? input.structureJson : input.structure,
        input.structureValidation || {}
      );
    }

    const nextTitle = hasOwn(changes, 'title') ? changes.title : memory.title;
    const nextSummary = hasOwn(changes, 'summary') ? changes.summary : memory.summary;
    const nextContent = hasOwn(changes, 'content') ? changes.content : memory.content;
    const nextTags = hasOwn(input, 'tags') ? normalizeTags(input.tags) : null;
    const nextLinks = hasOwn(input, 'links') ? normalizeLinks(input.links) : null;

    if (Object.keys(changes).length === 0 && nextTags == null && nextLinks == null) {
      throw new Error('At least one memory change is required.');
    }

    const setClauses = ['updated_at = ?'];
    const setParams = [now];

    if (hasOwn(changes, 'type')) {
      setClauses.push('type = ?');
      setParams.push(changes.type);
    }
    if (hasOwn(changes, 'scope')) {
      setClauses.push('scope = ?');
      setParams.push(changes.scope);
    }
    if (hasOwn(changes, 'projectKey')) {
      setClauses.push('project_key = ?');
      setParams.push(changes.projectKey);
    }
    if (hasOwn(changes, 'workspacePath')) {
      setClauses.push('workspace_path = ?');
      setParams.push(changes.workspacePath);
    }
    if (hasOwn(changes, 'sessionId')) {
      setClauses.push('session_id = ?');
      setParams.push(changes.sessionId);
    }
    if (hasOwn(changes, 'title')) {
      setClauses.push('title = ?');
      setParams.push(nextTitle);
    }
    if (hasOwn(changes, 'summary')) {
      setClauses.push('summary = ?');
      setParams.push(nextSummary);
    }
    if (hasOwn(changes, 'content')) {
      setClauses.push('content = ?');
      setParams.push(nextContent);
    }
    if (hasOwn(changes, 'status')) {
      setClauses.push('status = ?');
      setParams.push(changes.status);
    }
    if (hasOwn(changes, 'confidence')) {
      setClauses.push('confidence = ?');
      setParams.push(changes.confidence);
    }
    if (hasOwn(changes, 'stability')) {
      setClauses.push('stability = ?');
      setParams.push(changes.stability);
    }
    if (hasOwn(changes, 'sourceKind')) {
      setClauses.push('source_kind = ?');
      setParams.push(changes.sourceKind);
    }
    if (hasOwn(changes, 'sourceRef')) {
      setClauses.push('source_ref = ?');
      setParams.push(changes.sourceRef);
    }
    if (hasOwn(changes, 'subjectKind')) {
      setClauses.push('subject_kind = ?');
      setParams.push(changes.subjectKind);
    }
    if (hasOwn(changes, 'subjectRef')) {
      setClauses.push('subject_ref = ?');
      setParams.push(changes.subjectRef);
    }
    if (hasOwn(changes, 'workflowId')) {
      setClauses.push('workflow_id = ?');
      setParams.push(changes.workflowId);
    }
    if (hasOwn(changes, 'taskId')) {
      setClauses.push('task_id = ?');
      setParams.push(changes.taskId);
    }
    if (hasOwn(changes, 'eventKind')) {
      setClauses.push('event_kind = ?');
      setParams.push(changes.eventKind);
    }
    if (hasOwn(changes, 'structureJson')) {
      setClauses.push('structure_json = ?');
      setParams.push(changes.structureJson);
    }

    setClauses.push('content_hash = ?');
    setParams.push(createContentHash({
      title: nextTitle,
      summary: nextSummary,
      content: nextContent
    }));

    database.prepare(`
      UPDATE memory_records
      SET ${setClauses.join(', ')}
      WHERE memory_id = ?
    `).run(...setParams, memoryId);

    if (nextTags !== null) {
      replaceMemoryTagsSync(database, memoryId, nextTags, now);
    }

    if (nextLinks !== null) {
      insertMemoryLinksSync(database, memoryId, nextLinks, now);
    }

    upsertMemoryFtsSync(database, {
      memoryId,
      title: nextTitle,
      summary: nextSummary,
      content: nextContent
    });

    const nextStatus = hasOwn(changes, 'status') ? changes.status : memory.status;
    const lastEvent = insertMemoryEventSync(database, {
      memoryId,
      action: resolveMemoryStatusEventAction(memory.status, nextStatus),
      message: normalizeOptionalText(input.message) || 'Updated memory.',
      payload: {
        changedFields: Object.keys(changes),
        previousStatus: memory.status,
        status: nextStatus,
        replacedTags: Boolean(nextTags),
        addedLinkCount: nextLinks?.length || 0,
        subjectKind: hasOwn(changes, 'subjectKind') ? changes.subjectKind : memory.subjectKind,
        subjectRef: hasOwn(changes, 'subjectRef') ? changes.subjectRef : memory.subjectRef,
        workflowId: hasOwn(changes, 'workflowId') ? changes.workflowId : memory.workflowId,
        taskId: hasOwn(changes, 'taskId') ? changes.taskId : memory.taskId,
        eventKind: hasOwn(changes, 'eventKind') ? changes.eventKind : memory.eventKind,
        hasStructure: hasOwn(changes, 'structureJson') ? changes.structureJson != null : memory.structureJson != null
      },
      createdAt: now
    });

    return {
      memory: requireMemory(database, memoryId),
      lastEvent
    };
  });

  return applyUpdate();
}

function archiveMemory(database, input = {}) {
  const memoryId = normalizeRequiredText(input.memoryId, 'Memory id');

  const applyArchive = database.transaction(() => {
    const memory = requireMemory(database, memoryId);
    const now = createTimestamp();

    database.prepare(`
      UPDATE memory_records
      SET status = ?, updated_at = ?
      WHERE memory_id = ?
    `).run('archived', now, memoryId);

    const lastEvent = insertMemoryEventSync(database, {
      memoryId,
      action: 'archived',
      message: normalizeOptionalText(input.reason) || 'Archived memory.',
      payload: {
        previousStatus: memory.status
      },
      createdAt: now
    });

    return {
      memory: requireMemory(database, memoryId),
      lastEvent
    };
  });

  return applyArchive();
}

function recallMemories(database, query = {}, semanticOptions) {
  const tags = normalizeTags(query.tags);
  const textQuery = normalizeOptionalText(query.text);
  const ftsQuery = buildFtsMatchQuery(textQuery);
  const hasTextQuery = Boolean(ftsQuery);
  const minConfidence = normalizeOptionalNumber(query.minConfidence, 'minConfidence');
  const limit = normalizeOptionalPositiveInteger(query.limit, 'limit');
  const semanticConfig = resolveSemanticRecallConfig(query, semanticOptions);
  const recallStatuses = normalizeRecallStatuses(query);
  const candidateLimit = semanticConfig.enabled && hasTextQuery
    ? Math.max(limit || 0, semanticConfig.candidateLimit)
    : limit;
  const subjectKind = normalizeOptionalText(query.subjectKind);
  const subjectRef = normalizeOptionalText(query.subjectRef);
  const workflowId = normalizeOptionalText(query.workflowId);
  const taskId = normalizeOptionalText(query.taskId);
  const eventKinds = normalizeRecallEventKinds(query);
  const linkRelations = normalizeRecallLinkRelations(query);
  const graphEnabled = query.graph !== false;
  const structuralFilters = [];

  if (subjectKind) {
    structuralFilters.push('subjectKind');
  }
  if (subjectRef) {
    structuralFilters.push('subjectRef');
  }
  if (workflowId) {
    structuralFilters.push('workflowId');
  }
  if (taskId) {
    structuralFilters.push('taskId');
  }
  if (eventKinds.length > 0) {
    structuralFilters.push('eventKind');
  }

  const hasSeedFilters = query.sourceRef != null || structuralFilters.length > 0;

  const seedQuery = buildBaseRecallQuery({
    textQuery: null,
    hasTextQuery: false,
    recallStatuses,
    query,
    tags,
    minConfidence,
    subjectKind,
    subjectRef,
    workflowId,
    taskId,
    eventKinds,
    includeStructuralFilters: true
  });
  const graphQuery = buildBaseRecallQuery({
    textQuery: null,
    hasTextQuery: false,
    recallStatuses,
    query: {
      ...query,
      sourceKind: undefined,
      sourceRef: undefined
    },
    tags,
    minConfidence,
    includeStructuralFilters: false
  });
  const lexicalQuery = buildBaseRecallQuery({
    textQuery,
    hasTextQuery,
    recallStatuses,
    query,
    tags,
    minConfidence,
    subjectKind,
    subjectRef,
    workflowId,
    taskId,
    eventKinds,
    includeStructuralFilters: false
  });

  const seedRows = hasSeedFilters
    ? executeRecallRows(database, seedQuery, { limit: candidateLimit })
    : [];
  const exactSeedRows = seedRows.filter((row) => row.source_ref && query.sourceRef != null && row.source_ref === query.sourceRef);
  const structuralSeedRows = seedRows.filter((row) => !exactSeedRows.some((item) => item.memory_id === row.memory_id));
  const seedMemoryIds = [...new Set(seedRows.map((row) => row.memory_id))];
  const graphRows = graphEnabled && seedMemoryIds.length > 0
    ? recallGraphLinkedRows(database, {
        memoryIds: seedMemoryIds,
        baseQuery: graphQuery,
        relations: linkRelations,
        limit: candidateLimit
      })
    : [];
  const lexicalRows = executeRecallRows(database, lexicalQuery, { limit: candidateLimit });

  const totalIds = new Set();
  for (const row of exactSeedRows) totalIds.add(row.memory_id);
  for (const row of structuralSeedRows) totalIds.add(row.memory_id);
  for (const row of graphRows) totalIds.add(row.memory_id);
  for (const row of lexicalRows) totalIds.add(row.memory_id);

  const exactItems = exactSeedRows.map((row, index) => createRecallItemFromRow(row, {
    filters: seedQuery.filters,
    hasTextQuery: false,
    lexicalRank: index + 1,
    sourceRefMatched: query.sourceRef != null,
    subjectRefMatched: subjectRef != null && row.subject_ref === subjectRef,
    workflowIdMatched: workflowId != null && row.workflow_id === workflowId,
    taskIdMatched: taskId != null && row.task_id === taskId,
    eventKindMatched: eventKinds.length > 0 && eventKinds.includes(row.event_kind)
  }));
  const structuralItems = structuralSeedRows.map((row, index) => createRecallItemFromRow(row, {
    filters: seedQuery.filters,
    hasTextQuery: false,
    lexicalRank: index + 1,
    sourceRefMatched: query.sourceRef != null && row.source_ref === query.sourceRef,
    subjectRefMatched: subjectRef != null && row.subject_ref === subjectRef,
    workflowIdMatched: workflowId != null && row.workflow_id === workflowId,
    taskIdMatched: taskId != null && row.task_id === taskId,
    eventKindMatched: eventKinds.length > 0 && eventKinds.includes(row.event_kind)
  }));
  const graphItems = graphRows.map((row, index) => createRecallItemFromRow(row, {
    filters: [...graphQuery.filters, 'graph'],
    hasTextQuery: false,
    lexicalRank: index + 1,
    sourceRefMatched: query.sourceRef != null && row.source_ref === query.sourceRef,
    subjectRefMatched: subjectRef != null && row.subject_ref === subjectRef,
    workflowIdMatched: workflowId != null && row.workflow_id === workflowId,
    taskIdMatched: taskId != null && row.task_id === taskId,
    eventKindMatched: eventKinds.length > 0 && eventKinds.includes(row.event_kind),
    graphMatched: true,
    graphRelations: extractGraphRelations(row),
    graphSeedMemoryIds: extractGraphSeedMemoryIds(row)
  }));

  const selectedSeedItems = dedupeRecallItemsById([...exactItems, ...structuralItems, ...graphItems]);
  const lexicalCandidates = lexicalRows
    .map((row, index) => createRecallItemFromRow(row, {
      filters: lexicalQuery.filters,
      hasTextQuery,
      lexicalRank: index + 1,
      sourceRefMatched: query.sourceRef != null && row.source_ref === query.sourceRef,
      subjectRefMatched: subjectRef != null && row.subject_ref === subjectRef,
      workflowIdMatched: workflowId != null && row.workflow_id === workflowId,
      taskIdMatched: taskId != null && row.task_id === taskId,
      eventKindMatched: eventKinds.length > 0 && eventKinds.includes(row.event_kind)
    }))
    .filter((item) => !selectedSeedItems.some((existing) => existing.memoryId === item.memoryId));

  const semanticLaneLimit = resolveSemanticRecallLaneLimit({
    limit,
    semanticEnabled: semanticConfig.enabled,
    hasTextQuery,
    candidateCount: lexicalCandidates.length
  });
  const selectedSeedSlice = limit == null
    ? selectedSeedItems
    : selectedSeedItems.slice(0, Math.max(0, limit - semanticLaneLimit));
  const availableSlots = limit == null
    ? lexicalCandidates.length
    : Math.max(0, limit - selectedSeedSlice.length);
  const lexicalSlice = limit == null ? lexicalCandidates : lexicalCandidates.slice(0, availableSlots);
  const useSemanticRerank = semanticConfig.enabled && hasTextQuery && lexicalSlice.length > 0;
  const reranked = useSemanticRerank
    ? applySemanticRerank(database, lexicalSlice, textQuery, semanticConfig)
    : {
        items: lexicalSlice,
        diagnostics: {
          enabled: semanticConfig.enabled,
          applied: false,
          reason: semanticConfig.enabled ? (hasTextQuery ? 'no-lexical-gap' : 'text-query-required') : 'disabled',
          candidateCount: lexicalSlice.length,
          rerankedCount: lexicalSlice.length,
          fallbackUsed: false,
          modelKey: semanticConfig.modelKey,
          queryEmbeddingRefreshed: false,
          staleEmbeddingCount: 0,
          error: null,
          reservedSlots: semanticLaneLimit
        }
      };

  const finalItems = dedupeRecallItemsById([
    ...selectedSeedSlice,
    ...(limit == null ? reranked.items : reranked.items.slice(0, availableSlots))
  ]).slice(0, limit == null ? undefined : limit).map((item) => ({
    ...item,
    matchedBy: {
      ...item.matchedBy,
      semantic: Boolean(item.ranking?.semanticApplied)
    }
  }));

  if (finalItems.length > 0) {
    const now = createTimestamp();
    const memoryIds = finalItems.map((item) => item.memoryId);

    const logRecall = database.transaction(() => {
      if (memoryIds.length > 0) {
        const placeholders = memoryIds.map(() => '?').join(', ');
        database.prepare(`
          UPDATE memory_records
          SET last_recalled_at = ?
          WHERE memory_id IN (${placeholders})
        `).run(now, ...memoryIds);
      }

      for (const item of finalItems) {
        insertMemoryEventSync(database, {
          memoryId: item.memoryId,
          action: 'recalled',
          message: 'Recalled memory.',
          payload: {
            query: {
              text: textQuery,
              type: query.type ?? null,
              scope: query.scope ?? null,
              projectKey: query.projectKey ?? null,
              workspacePath: query.workspacePath ?? null,
              sessionId: query.sessionId ?? null,
              sourceKind: query.sourceKind ?? null,
              sourceRef: query.sourceRef ?? null,
              subjectKind,
              subjectRef,
              workflowId,
              taskId,
              eventKinds,
              graph: {
                enabled: graphEnabled,
                relations: linkRelations,
                seedCount: seedMemoryIds.length,
                recalledCount: graphItems.length
              },
              statuses: recallStatuses,
              tags,
              semantic: {
                enabled: semanticConfig.enabled,
                applied: reranked.diagnostics.applied,
                candidateLimit: semanticConfig.candidateLimit,
                fallbackUsed: reranked.diagnostics.fallbackUsed,
                error: reranked.diagnostics.error
              }
            }
          },
          createdAt: now
        });
      }
    });

    logRecall();
  }

  return {
    items: finalItems,
    query: {
      ...query,
      statuses: recallStatuses,
      tags,
      eventKinds,
      linkRelations
    },
    total: totalIds.size,
    diagnostics: {
      seeds: {
        exactCount: exactItems.length,
        structuralCount: structuralItems.length,
        graphCount: graphItems.length
      },
      graph: {
        enabled: graphEnabled,
        seedCount: seedMemoryIds.length,
        recalledCount: graphItems.length,
        relations: linkRelations
      },
      semantic: {
        ...reranked.diagnostics,
        fallbackOnly: selectedSeedItems.length > 0,
        reservedSlots: reranked.diagnostics?.reservedSlots ?? semanticLaneLimit,
        seedCount: selectedSeedItems.length,
        selectedSeedCount: selectedSeedSlice.length
      }
    }
  };
}



function resolveSemanticRecallLaneLimit(input = {}) {
  if (!input.semanticEnabled || !input.hasTextQuery) {
    return 0;
  }

  const candidateCount = normalizeOptionalPositiveInteger(input.candidateCount, 'semantic candidate count') || 0;
  if (candidateCount <= 0) {
    return 0;
  }

  if (input.limit == null) {
    return candidateCount;
  }

  const limit = normalizeOptionalPositiveInteger(input.limit, 'recall limit');
  if (!limit) {
    return 0;
  }

  return Math.min(candidateCount, Math.max(1, Math.floor(limit / 2)));
}


function buildBaseRecallQuery(input = {}) {
  const filters = [];
  const params = [];
  const whereClauses = [];
  const hasTextQuery = Boolean(input.hasTextQuery);
  const ftsQuery = buildFtsMatchQuery(input.textQuery);
  const recallStatuses = Array.isArray(input.recallStatuses) ? input.recallStatuses : normalizeRecallStatuses({});
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const eventKinds = Array.isArray(input.eventKinds) ? input.eventKinds : [];
  const minConfidence = input.minConfidence;
  const query = input.query || {};

  if (hasTextQuery && ftsQuery) {
    whereClauses.push('memory_fts MATCH ?');
    params.push(ftsQuery);
  }

  if (recallStatuses.length === 1) {
    whereClauses.push('mr.status = ?');
    params.push(recallStatuses[0]);
  } else {
    whereClauses.push(`mr.status IN (${recallStatuses.map(() => '?').join(', ')})`);
    params.push(...recallStatuses);
  }

  if (!isDefaultRecallStatuses(recallStatuses)) {
    filters.push('status');
  }

  if (query.type != null) {
    whereClauses.push('mr.type = ?');
    params.push(normalizeRequiredText(query.type, 'Memory type'));
    filters.push('type');
  }

  if (query.scope != null) {
    whereClauses.push('mr.scope = ?');
    params.push(normalizeRequiredText(query.scope, 'Memory scope'));
    filters.push('scope');
  }

  if (query.projectKey != null) {
    whereClauses.push('mr.project_key = ?');
    params.push(normalizeRequiredText(query.projectKey, 'projectKey'));
    filters.push('projectKey');
  }

  if (query.workspacePath != null) {
    whereClauses.push('mr.workspace_path = ?');
    params.push(normalizeRequiredWorkspacePath(query.workspacePath, 'workspacePath'));
    filters.push('workspacePath');
  }

  if (query.sessionId != null) {
    whereClauses.push('mr.session_id = ?');
    params.push(normalizeRequiredText(query.sessionId, 'sessionId'));
    filters.push('sessionId');
  }

  if (query.sourceKind != null) {
    whereClauses.push('mr.source_kind = ?');
    params.push(normalizeRequiredText(query.sourceKind, 'sourceKind'));
    filters.push('sourceKind');
  }

  if (query.sourceRef != null) {
    whereClauses.push('mr.source_ref = ?');
    params.push(normalizeRequiredText(query.sourceRef, 'sourceRef'));
    filters.push('sourceRef');
  }

  if (input.includeStructuralFilters) {
    if (input.subjectKind != null) {
      whereClauses.push('mr.subject_kind = ?');
      params.push(normalizeRequiredText(input.subjectKind, 'subjectKind'));
      filters.push('subjectKind');
    }

    if (input.subjectRef != null) {
      whereClauses.push('mr.subject_ref = ?');
      params.push(normalizeRequiredText(input.subjectRef, 'subjectRef'));
      filters.push('subjectRef');
    }

    if (input.workflowId != null) {
      whereClauses.push('mr.workflow_id = ?');
      params.push(normalizeRequiredText(input.workflowId, 'workflowId'));
      filters.push('workflowId');
    }

    if (input.taskId != null) {
      whereClauses.push('mr.task_id = ?');
      params.push(normalizeRequiredText(input.taskId, 'taskId'));
      filters.push('taskId');
    }

    if (eventKinds.length === 1) {
      whereClauses.push('mr.event_kind = ?');
      params.push(eventKinds[0]);
      filters.push('eventKind');
    } else if (eventKinds.length > 1) {
      whereClauses.push(`mr.event_kind IN (${eventKinds.map(() => '?').join(', ')})`);
      params.push(...eventKinds);
      filters.push('eventKind');
    }
  }

  const globalMinConfidence = input.globalMinConfidence != null ? input.globalMinConfidence : (query.globalMinConfidence != null ? query.globalMinConfidence : 0.3);
  if (globalMinConfidence > 0) {
    whereClauses.push('COALESCE(mr.confidence, 0) >= ?');
    params.push(globalMinConfidence);
    filters.push('globalMinConfidence');
  }

  if (minConfidence != null) {
    whereClauses.push('COALESCE(mr.confidence, 0) >= ?');
    params.push(minConfidence);
    filters.push('minConfidence');
  }

  if (tags.length > 0) {
    whereClauses.push(`mr.memory_id IN (
      SELECT memory_id
      FROM memory_tags
      WHERE tag IN (${tags.map(() => '?').join(', ')})
      GROUP BY memory_id
      HAVING COUNT(DISTINCT tag) = ?
    )`);
    params.push(...tags, tags.length);
    filters.push('tags');
  }

  return {
    filters,
    params,
    whereClauses,
    fromClause: hasTextQuery && ftsQuery
      ? 'FROM memory_records mr JOIN memory_fts ON memory_fts.memory_id = mr.memory_id'
      : 'FROM memory_records mr',
    selectRank: hasTextQuery && ftsQuery ? ', bm25(memory_fts) AS text_rank' : ', NULL AS text_rank',
    orderBy: hasTextQuery && ftsQuery
      ? 'ORDER BY text_rank ASC, COALESCE(mr.confidence, 0) DESC, mr.updated_at DESC, mr.created_at DESC'
      : 'ORDER BY COALESCE(mr.confidence, 0) DESC, mr.updated_at DESC, mr.created_at DESC'
  };
}

function executeRecallRows(database, recallQuery, options = {}) {
  const limit = normalizeOptionalPositiveInteger(options.limit, 'limit');
  const sql = `
    SELECT DISTINCT ${QUALIFIED_MEMORY_COLUMNS}${recallQuery.selectRank}
    ${recallQuery.fromClause}
    ${recallQuery.whereClauses.length > 0 ? `WHERE ${recallQuery.whereClauses.join(' AND ')}` : ''}
    ${recallQuery.orderBy}
    ${limit ? 'LIMIT ?' : ''}
  `;

  return database.prepare(sql).all(...(limit ? [...recallQuery.params, limit] : recallQuery.params));
}

function recallGraphLinkedRows(database, input = {}) {
  const memoryIds = Array.isArray(input.memoryIds) ? input.memoryIds.filter(Boolean) : [];
  if (memoryIds.length === 0) {
    return [];
  }

  const relations = Array.isArray(input.relations) ? input.relations.filter(Boolean) : [];
  const params = [...memoryIds, ...memoryIds];
  const whereClauses = [
    `(links.source_memory_id IN (${memoryIds.map(() => '?').join(', ')}) OR links.target_memory_id IN (${memoryIds.map(() => '?').join(', ')}))`
  ];

  if (relations.length === 1) {
    whereClauses.push('links.relation = ?');
    params.push(relations[0]);
  } else if (relations.length > 1) {
    whereClauses.push(`links.relation IN (${relations.map(() => '?').join(', ')})`);
    params.push(...relations);
  }

  const recallQuery = input.baseQuery;
  const sql = `
    SELECT DISTINCT ${QUALIFIED_MEMORY_COLUMNS},
      NULL AS text_rank,
      GROUP_CONCAT(DISTINCT links.relation) AS graph_relations,
      GROUP_CONCAT(DISTINCT CASE
        WHEN links.source_memory_id = mr.memory_id THEN links.target_memory_id
        ELSE links.source_memory_id
      END) AS graph_seed_memory_ids
    FROM memory_records mr
    JOIN memory_links links
      ON links.source_memory_id = mr.memory_id
      OR links.target_memory_id = mr.memory_id
    ${recallQuery.whereClauses.length > 0 ? `WHERE ${recallQuery.whereClauses.join(' AND ')} AND ` : 'WHERE '}
      ${whereClauses.join(' AND ')}
      AND mr.memory_id NOT IN (${memoryIds.map(() => '?').join(', ')})
    GROUP BY ${QUALIFIED_MEMORY_COLUMNS}
    ORDER BY COALESCE(mr.confidence, 0) DESC, mr.updated_at DESC, mr.created_at DESC
    ${input.limit ? 'LIMIT ?' : ''}
  `;

  return database.prepare(sql).all(
    ...recallQuery.params,
    ...params,
    ...memoryIds,
    ...(input.limit ? [input.limit] : [])
  );
}

function dedupeRecallItemsById(items) {
  const deduped = [];
  const seen = new Set();

  for (const item of items) {
    if (!item?.memoryId || seen.has(item.memoryId)) {
      continue;
    }
    seen.add(item.memoryId);
    deduped.push(item);
  }

  return deduped;
}

function normalizeRecallEventKinds(query = {}) {
  if (Array.isArray(query.eventKinds)) {
    return [...new Set(query.eventKinds.map((value, index) => normalizeRequiredText(value, `eventKinds[${index}]`)))];
  }

  if (query.eventKind != null) {
    return [normalizeRequiredText(query.eventKind, 'eventKind')];
  }

  return [];
}

function normalizeRecallLinkRelations(query = {}) {
  if (Array.isArray(query.linkRelations)) {
    return [...new Set(query.linkRelations.map((value, index) => normalizeRequiredText(value, `linkRelations[${index}]`)))];
  }

  if (query.linkRelation != null) {
    return [normalizeRequiredText(query.linkRelation, 'linkRelation')];
  }

  return [];
}

function extractGraphRelations(row) {
  return String(row?.graph_relations || '')
    .split(',')
    .map((value) => normalizeOptionalText(value))
    .filter(Boolean);
}

function extractGraphSeedMemoryIds(row) {
  return String(row?.graph_seed_memory_ids || '')
    .split(',')
    .map((value) => normalizeOptionalText(value))
    .filter(Boolean);
}

function getMemoryState(database, memoryId, query = {}) {
  const normalizedMemoryId = normalizeRequiredText(memoryId, 'Memory id');
  const state = {
    memory: requireMemory(database, normalizedMemoryId),
    tags: listMemoryTags(database, normalizedMemoryId)
  };

  if (query.includeLinks !== false) {
    state.links = listMemoryLinks(database, normalizedMemoryId);
  }

  if (query.includeEvents) {
    state.events = listMemoryEvents(database, normalizedMemoryId, query);
  }

  return state;
}

function requireMemory(database, memoryId) {
  const memory = getMemory(database, memoryId);
  if (!memory) {
    throw new Error('Memory not found.');
  }

  return memory;
}

function replaceMemoryTagsSync(database, memoryId, tags, createdAt) {
  database.transaction(() => {
    database.prepare(`
      DELETE FROM memory_tags
      WHERE memory_id = ?
    `).run(memoryId);

    if (tags.length === 0) {
      return;
    }

    const insertTag = database.prepare(`
      INSERT INTO memory_tags (
        memory_id,
        tag,
        created_at
      ) VALUES (?, ?, ?)
    `);

    for (const tag of tags) {
      insertTag.run(memoryId, tag, createdAt);
    }
  })();
}

function insertMemoryLinksSync(database, sourceMemoryId, links, createdAt) {
  if (links.length === 0) {
    return [];
  }

  const targetIds = [...new Set(links.map((link) => link.targetMemoryId))];
  const placeholders = targetIds.map(() => '?').join(', ');
  const existingRows = database.prepare(`
    SELECT memory_id FROM memory_records WHERE memory_id IN (${placeholders})
  `).all(...targetIds);
  const existingIds = new Set(existingRows.map((row) => row.memory_id));

  for (const link of links) {
    if (!existingIds.has(link.targetMemoryId)) {
      throw new Error(`Target memory "${link.targetMemoryId}" not found.`);
    }
  }

  const insertLink = database.prepare(`
    INSERT OR IGNORE INTO memory_links (
      link_id,
      source_memory_id,
      target_memory_id,
      relation,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const inserted = [];
  for (const link of links) {
    const linkId = crypto.randomUUID();
    const result = insertLink.run(
      linkId,
      sourceMemoryId,
      link.targetMemoryId,
      link.relation,
      createdAt
    );

    if (result.changes > 0) {
      inserted.push({
        linkId,
        sourceMemoryId,
        targetMemoryId: link.targetMemoryId,
        relation: link.relation,
        createdAt
      });
    }
  }

  return inserted;
}

function insertMemoryEventSync(database, input = {}) {
  const eventId = input.eventId || crypto.randomUUID();

  database.prepare(`
    INSERT INTO memory_events (
      event_id,
      memory_id,
      action,
      message,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    input.memoryId,
    input.action,
    input.message,
    stringifyJson(input.payload),
    input.createdAt || createTimestamp()
  );

  const row = database.prepare(`
    SELECT ${EVENT_COLUMNS}
    FROM memory_events
    WHERE event_id = ?
    LIMIT 1
  `).get(eventId);

  return mapEventRow(row);
}

function upsertMemoryFtsSync(database, memory) {
  database.transaction(() => {
    database.prepare(`
      DELETE FROM memory_fts
      WHERE memory_id = ?
    `).run(memory.memoryId);

    database.prepare(`
      INSERT INTO memory_fts (
        memory_id,
        title,
        summary,
        content
      ) VALUES (?, ?, ?, ?)
    `).run(
      memory.memoryId,
      memory.title || '',
      memory.summary || '',
      memory.content || ''
    );
  })();
}

function rebuildMemoryFtsSync(database) {
  database.prepare('DELETE FROM memory_fts').run();

  const rows = database.prepare(`
    SELECT memory_id, title, summary, content
    FROM memory_records
    ORDER BY created_at ASC, memory_id ASC
  `).all();

  const insertRow = database.prepare(`
    INSERT INTO memory_fts (
      memory_id,
      title,
      summary,
      content
    ) VALUES (?, ?, ?, ?)
  `);

  for (const row of rows) {
    insertRow.run(
      row.memory_id,
      row.title || '',
      row.summary || '',
      row.content || ''
    );
  }
}

function createRecallItemFromRow(row, input = {}) {
  const item = mapMemoryRow(row);
  const lexicalScore = typeof row?.text_rank === 'number'
    ? normalizeLexicalScore(row.text_rank, input.lexicalRank || 1)
    : null;
  const graphRelations = Array.isArray(input.graphRelations)
    ? [...new Set(input.graphRelations.map((relation) => normalizeOptionalText(relation)).filter(Boolean))]
    : [];
  const graphSeedMemoryIds = Array.isArray(input.graphSeedMemoryIds)
    ? [...new Set(input.graphSeedMemoryIds.map((memoryId) => normalizeOptionalText(memoryId)).filter(Boolean))]
    : [];

  return {
    ...item,
    matchedBy: {
      filters: Array.isArray(input.filters) ? [...input.filters] : [],
      text: Boolean(input.hasTextQuery),
      semantic: false,
      sourceRef: Boolean(input.sourceRefMatched),
      subjectRef: Boolean(input.subjectRefMatched),
      workflowId: Boolean(input.workflowIdMatched),
      taskId: Boolean(input.taskIdMatched),
      eventKind: Boolean(input.eventKindMatched),
      graph: Boolean(input.graphMatched),
      graphRelations,
      graphSeedMemoryIds
    },
    ranking: {
      lexicalRank: input.lexicalRank || null,
      lexicalScore,
      semanticScore: null,
      hybridScore: lexicalScore,
      semanticApplied: false
    }
  };
}


function applySemanticRerank(database, items, textQuery, semanticConfig) {
  if (items.length === 0) {
    return {
      items,
      diagnostics: {
        enabled: true,
        applied: false,
        reason: 'no-candidates',
        candidateCount: 0,
        rerankedCount: 0,
        fallbackUsed: false,
        modelKey: semanticConfig.modelKey,
        queryEmbeddingRefreshed: false,
        staleEmbeddingCount: 0,
        error: null
      }
    };
  }

  try {
    const { embedder } = semanticConfig;
    const queryVector = normalizeEmbeddingVector(embedder.embed(textQuery, {
      kind: 'query',
      modelKey: semanticConfig.modelKey,
      text: textQuery
    }), 'query embedding');
    const now = createTimestamp();
    let staleEmbeddingCount = 0;

    const scoredItems = items.map((item) => {
      const { vector, refreshed } = getOrCreateMemoryEmbedding(database, item, semanticConfig, now);
      if (refreshed) {
        staleEmbeddingCount += 1;
      }
      const semanticScore = cosineSimilarity(queryVector, vector);
      const lexicalScore = item.ranking?.lexicalScore ?? 0;
      const hybridScore = lexicalScore + (semanticScore * semanticConfig.weight);

      return {
        ...item,
        matchedBy: {
          ...item.matchedBy,
          semantic: true
        },
        ranking: {
          ...item.ranking,
          semanticScore,
          hybridScore,
          semanticApplied: true
        }
      };
    });

    scoredItems.sort((left, right) => {
      const scoreDelta = (right.ranking?.hybridScore || 0) - (left.ranking?.hybridScore || 0);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const lexicalDelta = (left.ranking?.lexicalRank || Number.MAX_SAFE_INTEGER) - (right.ranking?.lexicalRank || Number.MAX_SAFE_INTEGER);
      if (lexicalDelta !== 0) {
        return lexicalDelta;
      }
      return (right.confidence || 0) - (left.confidence || 0);
    });

    const filteredItems = semanticConfig.minScore == null
      ? scoredItems
      : scoredItems.filter((item) => (item.ranking?.semanticScore || 0) >= semanticConfig.minScore);

    return {
      items: filteredItems,
      diagnostics: {
        enabled: true,
        applied: true,
        reason: 'reranked',
        candidateCount: items.length,
        rerankedCount: filteredItems.length,
        fallbackUsed: false,
        modelKey: semanticConfig.modelKey,
        queryEmbeddingRefreshed: true,
        staleEmbeddingCount,
        error: null
      }
    };
  } catch (error) {
    return {
      items,
      diagnostics: {
        enabled: true,
        applied: false,
        reason: 'embedder-error',
        candidateCount: items.length,
        rerankedCount: items.length,
        fallbackUsed: true,
        modelKey: semanticConfig.modelKey,
        queryEmbeddingRefreshed: false,
        staleEmbeddingCount: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function getOrCreateMemoryEmbedding(database, item, semanticConfig, now) {
  const existing = getStoredEmbedding(database, item.memoryId, semanticConfig.modelKey);
  if (existing && existing.contentHash === item.contentHash) {
    return {
      vector: existing.vector,
      refreshed: false
    };
  }

  const vector = normalizeEmbeddingVector(semanticConfig.embedder.embed(buildMemoryEmbeddingText(item), {
    kind: 'memory',
    memoryId: item.memoryId,
    modelKey: semanticConfig.modelKey,
    contentHash: item.contentHash
  }), `memory embedding for ${item.memoryId}`);

  upsertMemoryEmbeddingSync(database, {
    memoryId: item.memoryId,
    modelKey: semanticConfig.modelKey,
    contentHash: item.contentHash,
    vector,
    now
  });

  return {
    vector,
    refreshed: true
  };
}

function getStoredEmbedding(database, memoryId, modelKey) {
  const row = database.prepare(`
    SELECT memory_id, model_key, content_hash, vector_json, created_at, updated_at
    FROM memory_embeddings
    WHERE memory_id = ?
      AND model_key = ?
    LIMIT 1
  `).get(memoryId, modelKey);

  if (!row) {
    return null;
  }

  return {
    memoryId: row.memory_id,
    modelKey: row.model_key,
    contentHash: row.content_hash,
    vector: normalizeEmbeddingVector(parseJson(row.vector_json), `stored embedding for ${memoryId}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function upsertMemoryEmbeddingSync(database, input = {}) {
  database.prepare(`
    INSERT INTO memory_embeddings (
      memory_id,
      model_key,
      content_hash,
      vector_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id, model_key) DO UPDATE SET
      content_hash = excluded.content_hash,
      vector_json = excluded.vector_json,
      updated_at = excluded.updated_at
  `).run(
    input.memoryId,
    input.modelKey,
    input.contentHash,
    stringifyJson(input.vector),
    input.now,
    input.now
  );
}

function buildMemoryEmbeddingText(item = {}) {
  return [item.title, item.summary, item.content]
    .filter(Boolean)
    .join('\n\n');
}

function resolveSemanticRecallConfig(query = {}, semanticOptions) {
  const queryOverride = hasOwn(query, 'semantic') ? query.semantic : undefined;
  if (queryOverride === false) {
    return {
      enabled: false,
      candidateLimit: semanticOptions?.candidateLimit || DEFAULT_SEMANTIC_CANDIDATE_LIMIT,
      weight: semanticOptions?.weight || DEFAULT_SEMANTIC_WEIGHT,
      minScore: semanticOptions?.minScore ?? null,
      modelKey: semanticOptions?.modelKey || DEFAULT_SEMANTIC_MODEL_KEY,
      embedder: semanticOptions?.embedder || null
    };
  }

  return {
    enabled: Boolean(semanticOptions?.enabled && semanticOptions?.embedder),
    candidateLimit: semanticOptions?.candidateLimit || DEFAULT_SEMANTIC_CANDIDATE_LIMIT,
    weight: semanticOptions?.weight || DEFAULT_SEMANTIC_WEIGHT,
    minScore: semanticOptions?.minScore ?? null,
    modelKey: semanticOptions?.modelKey || DEFAULT_SEMANTIC_MODEL_KEY,
    embedder: semanticOptions?.embedder || null
  };
}

function normalizeMemoryOptions(memory) {
  if (memory == null || memory === false) {
    return null;
  }

  if (memory === true) {
    return {};
  }

  if (typeof memory !== 'object') {
    return null;
  }

  if (memory.enabled === false) {
    return null;
  }

  return memory;
}

function normalizeSemanticOptions(value) {
  if (value == null || value === false) {
    return null;
  }

  if (value === true) {
    return {
      enabled: true,
      candidateLimit: DEFAULT_SEMANTIC_CANDIDATE_LIMIT,
      weight: DEFAULT_SEMANTIC_WEIGHT,
      minScore: null,
      modelKey: DEFAULT_SEMANTIC_MODEL_KEY,
      embedder: null
    };
  }

  if (typeof value !== 'object') {
    throw new Error('semantic options must be an object.');
  }

  return {
    enabled: value.enabled === true,
    candidateLimit: normalizeOptionalPositiveInteger(value.candidateLimit, 'semantic candidateLimit') || DEFAULT_SEMANTIC_CANDIDATE_LIMIT,
    weight: normalizeSemanticWeight(value.weight),
    minScore: normalizeOptionalNumber(value.minScore, 'semantic minScore'),
    modelKey: normalizeOptionalText(value.modelKey) || DEFAULT_SEMANTIC_MODEL_KEY,
    embedder: normalizeEmbedder(value.embedder)
  };
}

function normalizeEmbedder(value) {
  if (value == null) {
    return null;
  }

  if (typeof value.embed !== 'function') {
    throw new Error('semantic embedder must expose an embed(text, context) function.');
  }

  return value;
}

function normalizeSemanticWeight(value) {
  if (value == null || value === '') {
    return DEFAULT_SEMANTIC_WEIGHT;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('semantic weight must be a non-negative number.');
  }

  return number;
}

function normalizeLexicalScore(textRank, lexicalRank) {
  if (!Number.isFinite(textRank)) {
    return lexicalRank ? 1 / lexicalRank : 0;
  }

  return 1 / (1 + Math.max(0, textRank));
}

function normalizeEmbeddingVector(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty numeric array.`);
  }

  const vector = value.map((entry) => {
    const number = Number(entry);
    if (!Number.isFinite(number)) {
      throw new Error(`${label} must contain only finite numbers.`);
    }
    return number;
  });

  return vector;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0 || left.length !== right.length) {
    throw new Error('embedding vectors must have the same non-zero length.');
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function mapMemoryRow(row) {
  if (!row) {
    return null;
  }

  return {
    memoryId: row.memory_id,
    type: row.type,
    scope: row.scope,
    projectKey: row.project_key,
    workspacePath: row.workspace_path,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    status: row.status,
    confidence: row.confidence,
    stability: row.stability,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    subjectKind: row.subject_kind,
    subjectRef: row.subject_ref,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    eventKind: row.event_kind,
    structureJson: parseJson(row.structure_json),
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRecalledAt: row.last_recalled_at
  };
}

function mapTagRow(row) {
  return {
    memoryId: row.memory_id,
    tag: row.tag,
    createdAt: row.created_at
  };
}

function mapLinkRow(row, memoryId) {
  const direction = row.source_memory_id === memoryId ? 'outgoing' : 'incoming';
  const otherMemoryId = direction === 'outgoing' ? row.target_memory_id : row.source_memory_id;

  return {
    linkId: row.link_id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    relation: row.relation,
    direction,
    otherMemoryId,
    createdAt: row.created_at
  };
}

function mapEventRow(row) {
  if (!row) {
    return null;
  }

  return {
    eventId: row.event_id,
    memoryId: row.memory_id,
    action: row.action,
    message: row.message,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  };
}

function hasColumn(database, tableName, columnName) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

function normalizeRequiredWorkspacePath(value, label) {
  const workspacePath = normalizeWorkspacePath(value);
  if (!workspacePath) {
    throw new Error(`${label} is required.`);
  }

  return workspacePath;
}

function buildFtsMatchQuery(value) {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }

  const tokens = [...new Set(text.match(/[\p{L}\p{N}]+/gu) || [])];

  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

function ensureColumn(database, tableName, columnName, columnDefinition) {
  if (!hasColumn(database, tableName, columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

function normalizeMemoryStatus(status) {
  const value = normalizeRequiredText(status, 'Memory status');
  if (!MEMORY_STATUSES.has(value)) {
    throw new Error(`Unsupported memory status: ${value}`);
  }

  return value;
}

function normalizeRecallStatuses(query = {}) {
  if (query && Array.isArray(query.statuses)) {
    const statuses = [...new Set(query.statuses.map((status) => normalizeMemoryStatus(status)))];
    return statuses.length > 0 ? statuses : [...DEFAULT_RECALL_STATUSES];
  }

  if (query && hasOwn(query, 'status') && query.status != null) {
    return [normalizeMemoryStatus(query.status)];
  }

  return [...DEFAULT_RECALL_STATUSES];
}

function isDefaultRecallStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length !== DEFAULT_RECALL_STATUSES.length) {
    return false;
  }

  return statuses.every((status, index) => status === DEFAULT_RECALL_STATUSES[index]);
}

function resolveMemoryStatusEventAction(previousStatus, nextStatus) {
  const previous = normalizeMemoryStatus(previousStatus);
  const next = normalizeMemoryStatus(nextStatus);

  if (previous === next) {
    return 'updated';
  }

  if (next === 'archived') {
    return 'archived';
  }

  if (next === 'superseded') {
    return 'superseded';
  }

  if (next === 'stale') {
    return 'staled';
  }

  if (previous !== 'active' && next === 'active') {
    return 'reactivated';
  }

  return 'updated';
}

function normalizeTags(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('tags must be an array.');
  }

  return [...new Set(value
    .map((tag) => normalizeOptionalText(tag))
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeLinks(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('links must be an array.');
  }

  return value.map((link, index) => {
    if (!link || typeof link !== 'object') {
      throw new Error(`Link at index ${index} must be an object.`);
    }

    return {
      targetMemoryId: normalizeRequiredText(link.targetMemoryId, `Link targetMemoryId at index ${index}`),
      relation: normalizeRequiredText(link.relation, `Link relation at index ${index}`)
    };
  });
}

function normalizeRequiredText(value, label) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function normalizeOptionalNumber(value, label) {
  if (value == null || value === '') {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a number.`);
  }

  return number;
}

function normalizeOptionalStructuredValue(value, options = {}) {
  if (value == null) {
    return null;
  }

  const validationMode = options.validationMode || 'strict';
  const minFieldCount = options.minFieldCount || 0;
  const requiredFields = options.requiredFields || [];

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return null;
    }

    const parsed = parseJson(text);
    if (parsed == null) {
      throw new Error('Structured memory value must be a valid JSON string. Ensure the string is properly formatted JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Structured memory value must be a JSON object. Arrays and primitives are not allowed.');
    }
    
    if (validationMode === 'strict') {
      validateStructuredObject(parsed, { minFieldCount, requiredFields });
    }
    
    return stringifyJson(parsed);
  }

  if (typeof value === 'object' && value !== null) {
    if (validationMode === 'strict') {
      validateStructuredObject(value, { minFieldCount, requiredFields });
    }
    return stringifyJson(value);
  }

  throw new Error('Structured memory value must be an object or valid JSON string. Received: ' + typeof value);
}

function validateStructuredObject(obj, options = {}) {
  const keys = Object.keys(obj);
  
  if (options.minFieldCount > 0 && keys.length < options.minFieldCount) {
    throw new Error(`Structured memory object must have at least ${options.minFieldCount} field(s). Found: ${keys.length}`);
  }
  
  if (options.requiredFields && options.requiredFields.length > 0) {
    const missingFields = options.requiredFields.filter(field => !keys.includes(field));
    if (missingFields.length > 0) {
      throw new Error(`Structured memory object is missing required fields: ${missingFields.join(', ')}`);
    }
  }
  
  return true;
}

function normalizeOptionalPositiveInteger(value, label) {
  if (value == null || value === '') {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.floor(number);
}

function createContentHash(input = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    title: input.title || null,
    summary: input.summary || null,
    content: input.content || null
  })).digest('hex');
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function createTimestamp() {
  return new Date().toISOString();
}
