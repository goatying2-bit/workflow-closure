import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentMemorySystem
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'memory-recall-eval.db');
const fixturePath = path.join(__dirname, 'fixtures', 'memory-recall-fixture.json');
const DEFAULT_HYBRID_CANDIDATE_LIMIT = 5;
const DEFAULT_HYBRID_WEIGHT = 0.5;
const RECALL_QUERY_FIELDS = [
  'text',
  'type',
  'scope',
  'projectKey',
  'workspacePath',
  'sessionId',
  'status',
  'sourceKind',
  'sourceRef',
  'tags',
  'minConfidence',
  'limit'
];

async function main() {
  await fs.rm(dbPath, { force: true });

  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  validateFixture(fixture);

  const baselineMemorySystem = await createAgentMemorySystem({ dbPath });
  const seededMemoryIds = [];

  for (const memory of fixture.memories) {
    const created = baselineMemorySystem.remember(memory);
    seededMemoryIds.push(created.memory.memoryId);
  }

  const hybridMemorySystem = await createAgentMemorySystem({
    dbPath,
    semantic: {
      enabled: true,
      candidateLimit: DEFAULT_HYBRID_CANDIDATE_LIMIT,
      weight: DEFAULT_HYBRID_WEIGHT,
      embedder: createSemanticEvalEmbedder()
    }
  });

  const queryReports = fixture.queries.map((query) => evaluateQueryModes({
    baselineMemorySystem,
    hybridMemorySystem,
    query
  }));
  const failedQueryIds = queryReports.filter((report) => !report.pass).map((report) => report.queryId);
  const report = {
    metadata: {
      ...fixture.metadata,
      fixturePath,
      dbPath,
      memoryCount: fixture.memories.length,
      queryCount: fixture.queries.length,
      seededMemoryIds,
      modes: {
        baseline: {
          semanticEnabled: false
        },
        hybrid: {
          semanticEnabled: true,
          candidateLimit: DEFAULT_HYBRID_CANDIDATE_LIMIT,
          weight: DEFAULT_HYBRID_WEIGHT,
          embedder: 'deterministic-fixture-embedder'
        }
      }
    },
    queries: queryReports,
    aggregate: buildAggregateReport(queryReports)
  };

  if (failedQueryIds.length > 0) {
    console.error('memory recall eval failed');
    console.error(JSON.stringify(report, null, 2));
    throw new Error(`Recall eval expectations failed for queries: ${failedQueryIds.join(', ')}`);
  }

  console.log('memory recall eval passed');
  console.log(JSON.stringify(report, null, 2));
}

function evaluateQueryModes({ baselineMemorySystem, hybridMemorySystem, query }) {
  const queryId = normalizeLabel(query.queryId, 'queryId');
  const description = normalizeOptionalText(query.description);
  const topK = normalizeTopK(query.topK);
  const baselineTopHit = normalizeOptionalText(query.baselineTopHit);
  const hybridTopHit = normalizeOptionalText(query.hybridTopHit);
  const hybridMustInclude = normalizeStringArray(query.hybridMustInclude, 'hybridMustInclude');
  const requireHybridRankImprovementFor = normalizeStringArray(query.requireHybridRankImprovementFor, 'requireHybridRankImprovementFor');
  const baselineReport = evaluateModeQuery(baselineMemorySystem, query, {
    mode: 'baseline',
    topK,
    expectedTopHit: baselineTopHit
  });
  const hybridReport = evaluateModeQuery(hybridMemorySystem, query, {
    mode: 'hybrid',
    topK,
    additionalMustInclude: hybridMustInclude,
    expectedTopHit: hybridTopHit
  });
  const comparison = buildModeComparison({
    baselineReport,
    hybridReport,
    requireHybridRankImprovementFor
  });
  const pass = baselineReport.pass && hybridReport.pass && comparison.pass;

  return {
    queryId,
    description,
    topK,
    expectations: {
      baselineTopHit,
      hybridTopHit,
      hybridMustInclude,
      requireHybridRankImprovementFor
    },
    baseline: baselineReport,
    hybrid: hybridReport,
    comparison,
    pass
  };
}

function evaluateModeQuery(memorySystem, query, options = {}) {
  const mode = normalizeLabel(options.mode, 'mode');
  const topK = normalizeTopK(options.topK);
  const mustInclude = normalizeStringArray(query.mustInclude, 'mustInclude');
  const mustExclude = normalizeStringArray(query.mustExclude, 'mustExclude');
  const additionalMustInclude = normalizeStringArray(options.additionalMustInclude, 'additionalMustInclude');
  const effectiveMustInclude = uniqueStrings([...mustInclude, ...additionalMustInclude]);
  const expectedTopHit = normalizeOptionalText(options.expectedTopHit);
  const recallQuery = extractRecallQuery(query);

  if (recallQuery.limit == null) {
    recallQuery.limit = Math.max(topK, 5);
  }

  const result = memorySystem.recall(recallQuery);
  const items = Array.isArray(result.items) ? result.items : [];
  const resultIds = items.map((item) => item.memoryId);
  const topHit = resultIds[0] || null;
  const topKIds = resultIds.slice(0, topK);
  const includeHitsWithinTopK = effectiveMustInclude.filter((memoryId) => topKIds.includes(memoryId));
  const excludeHitsWithinTopK = mustExclude.filter((memoryId) => topKIds.includes(memoryId));
  const missingWithinTopK = effectiveMustInclude.filter((memoryId) => !topKIds.includes(memoryId));
  const firstHitRank = findFirstRelevantRank(resultIds, effectiveMustInclude);
  const idealOrder = normalizeOptionalStringArray(query.idealOrder, 'idealOrder');
  const idealOrderMatched = idealOrder == null
    ? null
    : idealOrder.every((memoryId, index) => resultIds[index] === memoryId);
  const matchedBy = summarizeMatchedBy(items);
  const topHitMatched = expectedTopHit == null ? null : topHit === expectedTopHit;
  const pass = missingWithinTopK.length === 0
    && excludeHitsWithinTopK.length === 0
    && (idealOrderMatched == null || idealOrderMatched === true)
    && (topHitMatched == null || topHitMatched === true);

  return {
    mode,
    recallQuery,
    total: result.total,
    topHit,
    resultIds,
    mustInclude,
    additionalMustInclude,
    effectiveMustInclude,
    mustExclude,
    includeHitsWithinTopK,
    excludeHitsWithinTopK,
    missingWithinTopK,
    firstHitRank,
    idealOrder,
    idealOrderMatched,
    expectedTopHit,
    topHitMatched,
    metrics: {
      recallAt3: calculateRecallAtK(resultIds, effectiveMustInclude, 3),
      recallAt5: calculateRecallAtK(resultIds, effectiveMustInclude, 5),
      precisionAt3: calculatePrecisionAtK(resultIds, effectiveMustInclude, 3),
      precisionAt5: calculatePrecisionAtK(resultIds, effectiveMustInclude, 5),
      reciprocalRank: firstHitRank ? 1 / firstHitRank : 0
    },
    matchedBy,
    diagnostics: result.diagnostics || null,
    pass
  };
}

function buildModeComparison({ baselineReport, hybridReport, requireHybridRankImprovementFor }) {
  const rankImprovements = requireHybridRankImprovementFor.map((memoryId) => {
    const baselineRank = findRank(baselineReport.resultIds, memoryId);
    const hybridRank = findRank(hybridReport.resultIds, memoryId);
    const improved = hybridRank != null && (baselineRank == null || hybridRank < baselineRank);

    return {
      memoryId,
      baselineRank,
      hybridRank,
      improved
    };
  });

  const improvedCount = rankImprovements.filter((item) => item.improved).length;
  const baselineFirstHitRank = baselineReport.firstHitRank;
  const hybridFirstHitRank = hybridReport.firstHitRank;
  const firstHitRankDelta = baselineFirstHitRank == null || hybridFirstHitRank == null
    ? null
    : baselineFirstHitRank - hybridFirstHitRank;
  const pass = rankImprovements.every((item) => item.improved);

  return {
    baselineFirstHitRank,
    hybridFirstHitRank,
    firstHitRankDelta,
    rankImprovements,
    improvedCount,
    pass
  };
}

function buildAggregateReport(queryReports) {
  const baselineReports = queryReports.map((report) => report.baseline);
  const hybridReports = queryReports.map((report) => report.hybrid);

  return {
    queryCount: queryReports.length,
    passCount: queryReports.filter((report) => report.pass).length,
    baseline: buildModeAggregateReport(baselineReports),
    hybrid: buildModeAggregateReport(hybridReports),
    comparison: buildComparisonAggregateReport(queryReports)
  };
}

function buildModeAggregateReport(modeReports) {
  const scoredReports = modeReports.filter((report) => report.effectiveMustInclude.length > 0);

  return {
    queryCount: modeReports.length,
    scoredQueryCount: scoredReports.length,
    passCount: modeReports.filter((report) => report.pass).length,
    recallAt3: average(scoredReports.map((report) => report.metrics.recallAt3)),
    recallAt5: average(scoredReports.map((report) => report.metrics.recallAt5)),
    precisionAt3: average(scoredReports.map((report) => report.metrics.precisionAt3)),
    precisionAt5: average(scoredReports.map((report) => report.metrics.precisionAt5)),
    meanReciprocalRank: average(scoredReports.map((report) => report.metrics.reciprocalRank)),
    matchedBy: modeReports.reduce((summary, report) => mergeMatchedBySummary(summary, report.matchedBy), createMatchedBySummary())
  };
}

function buildComparisonAggregateReport(queryReports) {
  const firstHitDeltas = queryReports
    .map((report) => report.comparison.firstHitRankDelta)
    .filter((value) => Number.isFinite(value));
  const rankImprovementChecks = queryReports.flatMap((report) => report.comparison.rankImprovements);

  return {
    comparedQueryCount: queryReports.length,
    firstHitRankDeltaAverage: average(firstHitDeltas),
    improvedQueryCount: queryReports.filter((report) => report.comparison.improvedCount > 0).length,
    requiredRankImprovementChecks: rankImprovementChecks.length,
    passedRankImprovementChecks: rankImprovementChecks.filter((item) => item.improved).length
  };
}

function extractRecallQuery(query) {
  const recallQuery = {};

  for (const field of RECALL_QUERY_FIELDS) {
    if (hasOwn(query, field)) {
      recallQuery[field] = query[field];
    }
  }

  return recallQuery;
}

function summarizeMatchedBy(items) {
  return items.reduce((summary, item) => {
    if (item.matchedBy?.text) {
      summary.textResultCount += 1;
    }

    if (item.matchedBy?.semantic) {
      summary.semanticResultCount += 1;
    }

    const filters = Array.isArray(item.matchedBy?.filters)
      ? item.matchedBy.filters
      : [];

    for (const filter of filters) {
      summary.filters[filter] = (summary.filters[filter] || 0) + 1;
    }

    return summary;
  }, createMatchedBySummary());
}

function createMatchedBySummary() {
  return {
    textResultCount: 0,
    semanticResultCount: 0,
    filters: {}
  };
}

function mergeMatchedBySummary(target, source) {
  target.textResultCount += source.textResultCount;
  target.semanticResultCount += source.semanticResultCount;

  for (const [filter, count] of Object.entries(source.filters)) {
    target.filters[filter] = (target.filters[filter] || 0) + count;
  }

  return target;
}

function findFirstRelevantRank(resultIds, mustInclude) {
  if (mustInclude.length === 0) {
    return null;
  }

  for (let index = 0; index < resultIds.length; index += 1) {
    if (mustInclude.includes(resultIds[index])) {
      return index + 1;
    }
  }

  return null;
}

function findRank(resultIds, memoryId) {
  if (!memoryId) {
    return null;
  }

  const index = resultIds.indexOf(memoryId);
  return index >= 0 ? index + 1 : null;
}

function calculateRecallAtK(resultIds, mustInclude, k) {
  if (mustInclude.length === 0) {
    return null;
  }

  const topIds = resultIds.slice(0, k);
  const hits = mustInclude.filter((memoryId) => topIds.includes(memoryId)).length;
  return hits / mustInclude.length;
}

function calculatePrecisionAtK(resultIds, mustInclude, k) {
  if (mustInclude.length === 0) {
    return null;
  }

  const topIds = resultIds.slice(0, k);
  const hits = topIds.filter((memoryId) => mustInclude.includes(memoryId)).length;
  return hits / k;
}

function average(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length === 0) {
    return null;
  }

  const total = numbers.reduce((sum, value) => sum + value, 0);
  return total / numbers.length;
}

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== 'object') {
    throw new Error('Fixture must be an object.');
  }

  if (!Array.isArray(fixture.memories) || fixture.memories.length === 0) {
    throw new Error('Fixture must include at least one memory.');
  }

  if (!Array.isArray(fixture.queries) || fixture.queries.length === 0) {
    throw new Error('Fixture must include at least one query.');
  }
}

function createSemanticEvalEmbedder() {
  return {
    embed(text, context = {}) {
      const normalizedText = String(text || '').toLowerCase();

      if (context.kind === 'query') {
        if (normalizedText.includes('alpha beta')) {
          return [1, 0];
        }

        return [0, 0];
      }

      if (normalizedText.includes('semantic target guidance')) {
        return [1, 0];
      }

      if (normalizedText.includes('lexical distractor')) {
        return [0, 1];
      }

      return [0, 0];
    }
  };
}

function normalizeTopK(value) {
  if (value == null) {
    return 3;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('topK must be a positive integer.');
  }

  return number;
}

function normalizeStringArray(value, label) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value.map((item) => normalizeLabel(item, label));
}

function normalizeOptionalStringArray(value, label) {
  if (value == null) {
    return null;
  }

  return normalizeStringArray(value, label);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeLabel(value, label) {
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  closeDb(dbPath);
});
