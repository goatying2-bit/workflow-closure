import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createJsonlRuleProvider,
  createRuleProvider,
  createWorkflowEngine,
  createWorkflowRunner
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'rule-provider-smoke-test.db');
const jsonlPath = path.join(__dirname, 'rule-provider-smoke-test.jsonl');

async function main() {
  await fs.rm(dbPath, { force: true });
  await fs.rm(jsonlPath, { force: true });

  await testFunctionRuleProvider();
  await testJsonlRuleProviderWithRunner();

  console.log('rule-provider smoke test passed');
}

async function testFunctionRuleProvider() {
  const provider = createRuleProvider(async () => ({
    rules: [
      { text: '优先输出最终结论。', priority: 5 },
      { text: '引用关键证据。', priority: 10 }
    ],
    metadata: {
      ruleProvider: 'custom-function'
    }
  }));

  const result = await provider.getRules({ workflowId: 'function-rule-provider' });

  assert(result.rules.length === 2, 'function rule provider should return normalized rules');
  assert(result.rules[0].text === '引用关键证据。', 'function rule provider should sort rules by priority');
  assert(result.metadata.ruleProvider === 'custom-function', 'function rule provider should preserve metadata');
}

async function testJsonlRuleProviderWithRunner() {
  await fs.writeFile(jsonlPath, [
    JSON.stringify({ text: '最后再给结论。', priority: 1 }),
    JSON.stringify({ title: '证据优先', text: '先列出可信事实，再输出结论。', priority: 10 }),
    JSON.stringify({ text: '这条规则不应生效。', enabled: false, priority: 100 })
  ].join('\n'), 'utf8');

  const engine = await createWorkflowEngine({ dbPath });
  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    runnerId: 'runner-rule-provider',
    ruleProvider: createJsonlRuleProvider({ filePath: jsonlPath }),
    adapter: async ({ task, prompt, ruleContext }) => ({
      status: 'done',
      doneSummary: `已按规则完成：${task.title}`,
      payload: {
        promptIncludesPrimaryRule: prompt.includes('证据优先｜先列出可信事实，再输出结论。'),
        promptIncludesSecondaryRule: prompt.includes('最后再给结论。'),
        ruleCount: ruleContext.rules.length,
        firstRuleText: ruleContext.rules[0]?.text || null,
        providerKind: ruleContext.metadata?.ruleProvider || null
      }
    })
  });

  const workflow = engine.createWorkflowFromInstruction({
    instruction: '验证 rule provider 会注入执行规则',
    plan: {
      goal: '验证 rule provider 会注入执行规则',
      steps: [
        {
          key: 'apply-rules',
          title: '执行受规则约束的任务',
          description: 'runner 应把外部规则拼进 prompt。'
        }
      ],
      dependencies: []
    }
  });

  const result = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks[0];

  assert(result.status === 'done', 'runner should finish the rule-provider workflow');
  assert(task.status === 'done', 'task should complete under the rule-provider runner');
  assert(result.ruleContext.rules.length === 2, 'jsonl rule provider should keep enabled rules only');
  assert(result.ruleContext.metadata?.ruleProvider === 'jsonl', 'jsonl rule provider should expose provider kind');
  assert(result.ruleContext.metadata?.filePath === jsonlPath, 'jsonl rule provider should expose source path');
  assert(result.prompt.includes('执行规则：'), 'prompt should keep the execution rules section');
  assert(result.prompt.includes('证据优先｜先列出可信事实，再输出结论。'), 'prompt should inject the highest priority external rule');
  assert(result.prompt.includes('最后再给结论。'), 'prompt should inject the lower priority external rule');
  assert(result.prompt.indexOf('证据优先｜先列出可信事实，再输出结论。') < result.prompt.indexOf('最后再给结论。'), 'prompt should render higher priority rules first');
  assert(result.adapterPayload?.promptIncludesPrimaryRule === true, 'adapter should receive the injected primary rule');
  assert(result.adapterPayload?.promptIncludesSecondaryRule === true, 'adapter should receive the injected secondary rule');
  assert(result.adapterPayload?.ruleCount === 2, 'adapter should receive normalized rule count');
  assert(result.adapterPayload?.providerKind === 'jsonl', 'adapter should receive rule provider metadata');
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
  await fs.rm(jsonlPath, { force: true }).catch(() => {});
  closeDb();
});
