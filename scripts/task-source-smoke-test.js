import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFileTaskSource,
  createJsonTaskSource,
  createTaskSource,
  createWorkflowEngine
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'task-source-smoke-test.db');
const jsonPath = path.join(__dirname, 'task-source-smoke-test.json');
const documentPath = path.join(__dirname, 'fixtures', 'task-source-placeholder.pdf');

async function main() {
  await fs.rm(dbPath, { force: true });
  await fs.rm(jsonPath, { force: true });

  await testJsonTaskSource();
  await testFunctionTaskSource();
  await testPlaceholderDocumentTaskSource();

  console.log('task-source smoke test passed');
}

async function testJsonTaskSource() {
  await fs.writeFile(jsonPath, JSON.stringify({
    workflowId: 'json-task-source-workflow',
    instruction: '通过 JSON task source 创建 workflow',
    goal: '通过 JSON task source 创建 workflow',
    steps: [
      {
        key: 'collect',
        title: '收集输入',
        description: '从 JSON task source 读取步骤定义。'
      },
      {
        key: 'apply',
        title: '落地 workflow',
        description: '把 JSON 步骤应用到 workflow 中。'
      },
      {
        key: 'verify',
        title: '验证导入结果',
        description: '确认 workflow 任务和依赖被正确创建。'
      }
    ],
    dependencies: [
      { from: 'collect', to: 'apply' },
      { from: 'apply', to: 'verify' }
    ]
  }, null, 2), 'utf8');

  const engine = await createWorkflowEngine({ dbPath });
  const created = await engine.createWorkflowFromTaskSource({
    taskSource: createJsonTaskSource({ filePath: jsonPath })
  });

  assert(created.workflow.workflowId === 'json-task-source-workflow', 'json task source should keep workflowId');
  assert(created.workflow.goal === '通过 JSON task source 创建 workflow', 'json task source should keep goal');
  assert(created.tasks.length === 3, 'json task source should create tasks from JSON steps');
  assert(created.dependencies.length === 2, 'json task source should create dependencies from JSON steps');
  assert(created.sourceResult.metadata?.taskSource === 'json', 'json task source should expose source kind');
  assert(created.sourceResult.metadata?.filePath === jsonPath, 'json task source should expose source path');
  assert(created.runLogs.some((log) => log.action === 'task_source_loaded'), 'json task source should record task source run log');
}

async function testFunctionTaskSource() {
  const engine = await createWorkflowEngine({ dbPath });
  const created = await engine.createWorkflowFromTaskSource({
    taskSource: createTaskSource(async () => ({
      instruction: '通过函数 task source 创建 workflow',
      plan: {
        goal: '通过函数 task source 创建 workflow',
        steps: [
          {
            key: 'step-1',
            title: '装载任务',
            description: '通过函数返回 plan。'
          },
          {
            key: 'step-2',
            title: '确认结果',
            description: '检查 workflow 是否正确创建。'
          }
        ],
        dependencies: [
          { from: 'step-1', to: 'step-2' }
        ]
      },
      metadata: {
        taskSource: 'custom-function'
      }
    }))
  });

  assert(created.workflow.goal === '通过函数 task source 创建 workflow', 'function task source should create workflow goal');
  assert(created.tasks.length === 2, 'function task source should create plan steps');
  assert(created.dependencies.length === 1, 'function task source should create plan dependencies');
  assert(created.sourceResult.metadata?.taskSource === 'custom-function', 'function task source should preserve metadata');
}

async function testPlaceholderDocumentTaskSource() {
  const engine = await createWorkflowEngine({ dbPath });
  const created = await engine.createWorkflowFromTaskSource({
    instruction: '通过占位文档 task source 创建 workflow',
    goal: '人工审阅 PDF 并整理任务',
    taskSource: createFileTaskSource({ filePath: documentPath })
  });

  assert(created.workflow.goal === '人工审阅 PDF 并整理任务', 'document task source should honor explicit goal');
  assert(created.tasks.length === 1, 'document task source should create a placeholder task');
  assert(created.dependencies.length === 0, 'document task source placeholder should not add dependencies');
  assert(created.tasks[0].title === '检查源文档', 'document task source should create the placeholder review task');
  assert(created.sourceResult.instruction === '通过占位文档 task source 创建 workflow', 'document task source should honor explicit instruction');
  assert(created.sourceResult.metadata?.taskSource === 'document-placeholder', 'document task source should expose placeholder source kind');
  assert(created.sourceResult.metadata?.parseMode === 'placeholder', 'document task source should mark placeholder parse mode');
  assert(created.sourceResult.metadata?.fileExtension === '.pdf', 'document task source should expose file extension');
  assert(created.sourceResult.metadata?.filePath === documentPath, 'document task source should expose file path');
  assert(created.sourceResult.metadata?.fileSize > 0, 'document task source should expose file size');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await fs.rm(jsonPath, { force: true }).catch(() => {});
  closeDb();
});
