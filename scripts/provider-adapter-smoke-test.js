import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAnthropicMessagesAdapter,
  createOpenAIChatCompletionsAdapter,
  createWorkflowEngine,
  createWorkflowRunner
} from '../index.js';
import { closeDb } from '../storage/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'provider-adapter-smoke-test.db');

async function main() {
  await fs.rm(dbPath, { force: true });

  await testAnthropicDone();
  await testOpenAIBlocked();
  await testInvalidNestedContractBlocked();
  await testHttpFailureBlocked();

  console.log('provider adapter smoke test passed');
}

async function testAnthropicDone() {
  let requestBody = null;
  let requestHeaders = null;
  let requestUrl = null;

  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'provider-anthropic-done',
    instruction: '验证 Anthropic provider adapter done 路径',
    title: '执行 Anthropic provider done',
    adapter: createAnthropicMessagesAdapter({
      apiKey: 'anthropic-test-key',
      model: 'claude-sonnet-test',
      fetchImpl: async (url, init = {}) => {
        requestUrl = url;
        requestHeaders = init.headers;
        requestBody = JSON.parse(String(init.body || '{}'));
        return createMockJsonResponse({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'done',
                doneSummary: 'anthropic provider smoke done',
                payload: {
                  worker: 'anthropic-smoke',
                  promptHasTask: String(requestBody?.messages?.[0]?.content || '').includes('## Task'),
                  promptRequiresJson: String(requestBody?.messages?.[0]?.content || '').includes('Return only valid JSON'),
                  systemInstruction: requestBody?.system || null
                },
                handoff: {
                  summary: 'anthropic handoff summary',
                  recommendedNextRole: 'reviewer'
                }
              })
            }
          ]
        });
      }
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const completionLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_completed_by_runner');

  assert(step.status === 'done', 'anthropic done path should complete');
  assert(task?.status === 'done', 'anthropic done task should persist done status');
  assert(step.task.doneSummary.includes('anthropic provider smoke done'), 'anthropic done path should preserve doneSummary');
  assert(step.handoff?.summary === 'anthropic handoff summary', 'anthropic done path should preserve handoff summary');
  assert(step.adapterPayload?.provider === 'anthropic-messages', 'anthropic done path should expose provider name');
  assert(step.adapterPayload?.workerPayload?.worker === 'anthropic-smoke', 'anthropic done path should preserve worker payload');
  assert(step.adapterPayload?.workerPayload?.promptHasTask === true, 'anthropic prompt should include task context');
  assert(step.adapterPayload?.workerPayload?.promptRequiresJson === true, 'anthropic prompt should require JSON output');
  assert(step.adapterPayload?.request?.model === 'claude-sonnet-test', 'anthropic done path should persist request model');
  assert(step.adapterPayload?.endpoint === requestUrl, 'anthropic done path should persist request endpoint');
  assert(requestHeaders?.['x-api-key'] === 'anthropic-test-key', 'anthropic done path should send api key header');
  assert(requestBody?.model === 'claude-sonnet-test', 'anthropic done path should send configured model');
  assert(typeof requestBody?.system === 'string' && requestBody.system.length > 0, 'anthropic done path should send system instruction');
  assert(completionLog?.payload?.adapterPayload?.provider === 'anthropic-messages', 'anthropic done run log should persist provider metadata');
}

async function testOpenAIBlocked() {
  let requestBody = null;
  let requestHeaders = null;

  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'provider-openai-blocked',
    instruction: '验证 OpenAI provider adapter blocked 路径',
    title: '执行 OpenAI provider blocked',
    adapter: createOpenAIChatCompletionsAdapter({
      apiKey: 'openai-test-key',
      model: 'gpt-test',
      maxCompletionTokens: 222,
      fetchImpl: async (_url, init = {}) => {
        requestHeaders = init.headers;
        requestBody = JSON.parse(String(init.body || '{}'));
        return createMockJsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: 'blocked',
                  blockedReason: 'openai provider smoke blocked',
                  payload: {
                    worker: 'openai-smoke',
                    promptHasTask: String(requestBody?.messages?.[1]?.content || '').includes('## Task'),
                    promptRequiresJson: String(requestBody?.messages?.[1]?.content || '').includes('Return only valid JSON')
                  }
                })
              }
            }
          ]
        });
      }
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const task = state.tasks.find((item) => item.taskId === step.task.taskId);
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'openai blocked path should block');
  assert(task?.status === 'blocked', 'openai blocked task should persist blocked status');
  assert(step.task.blockedReason.includes('openai provider smoke blocked'), 'openai blocked path should preserve blockedReason');
  assert(step.adapterPayload?.provider === 'openai-chat-completions', 'openai blocked path should expose provider name');
  assert(step.adapterPayload?.workerPayload?.worker === 'openai-smoke', 'openai blocked path should preserve worker payload');
  assert(step.adapterPayload?.workerPayload?.promptHasTask === true, 'openai prompt should include task context');
  assert(step.adapterPayload?.workerPayload?.promptRequiresJson === true, 'openai prompt should require JSON output');
  assert(requestHeaders?.authorization === 'Bearer openai-test-key', 'openai blocked path should send bearer token');
  assert(requestBody?.model === 'gpt-test', 'openai blocked path should send configured model');
  assert(requestBody?.max_completion_tokens === 222, 'openai blocked path should send max_completion_tokens');
  assert(Array.isArray(requestBody?.messages) && requestBody.messages.length === 2, 'openai blocked path should send system and user messages');
  assert(blockedLog?.payload?.adapterPayload?.provider === 'openai-chat-completions', 'openai blocked run log should persist provider metadata');
}

async function testInvalidNestedContractBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'provider-invalid-contract',
    instruction: '验证 provider adapter invalid nested contract 路径',
    title: '执行 provider invalid nested contract',
    adapter: createAnthropicMessagesAdapter({
      apiKey: 'anthropic-test-key',
      model: 'claude-sonnet-test',
      fetchImpl: async () => createMockJsonResponse({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'done',
              doneSummary: 'invalid nested contract should block',
              handoff: {
                summary: 'bad handoff',
                artifacts: [null]
              }
            })
          }
        ]
      })
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'provider invalid nested contract path should block');
  assert(step.task.blockedReason.includes('invalid adapter result'), 'provider invalid nested contract should explain contract failure');
  assert(step.adapterPayload?.parseError.includes('handoff.artifacts[0] must be a non-empty string'), 'provider invalid nested contract should expose nested validation error');
  assert(blockedLog?.payload?.adapterPayload?.parseError === step.adapterPayload.parseError, 'provider invalid nested contract run log should persist parseError');
}

async function testHttpFailureBlocked() {
  const { engine, workflow, runner } = await createSingleTaskRunner({
    runnerId: 'provider-http-failure',
    instruction: '验证 provider adapter http failure 路径',
    title: '执行 provider http failure',
    adapter: createOpenAIChatCompletionsAdapter({
      apiKey: 'openai-test-key',
      model: 'gpt-test',
      fetchImpl: async () => createMockJsonResponse({
        error: {
          message: 'rate limit exceeded'
        }
      }, {
        status: 429,
        statusText: 'Too Many Requests'
      })
    })
  });

  const step = await runner.runOnce();
  const state = engine.getWorkflowState({ workflowId: workflow.workflow.workflowId });
  const blockedLog = findTaskRunLog(state.runLogs, step.task.taskId, 'task_blocked_by_runner');

  assert(step.status === 'blocked', 'provider http failure path should block');
  assert(step.task.blockedReason.includes('HTTP 429'), 'provider http failure should mention status code');
  assert(step.adapterPayload?.http?.status === 429, 'provider http failure should persist status code');
  assert(step.adapterPayload?.error === 'rate limit exceeded', 'provider http failure should expose provider error message');
  assert(blockedLog?.payload?.adapterPayload?.http?.status === 429, 'provider http failure run log should persist status code');
}

async function createSingleTaskRunner({ runnerId, instruction, title, adapter }) {
  const engine = await createWorkflowEngine({ dbPath });
  const workflow = engine.createWorkflowFromInstruction({
    instruction,
    plan: {
      goal: instruction,
      steps: [
        {
          key: 'step-1',
          title,
          description: title
        }
      ],
      dependencies: []
    }
  });

  const runner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: workflow.workflow.workflowId,
    runnerId,
    adapter
  });

  return { engine, workflow, runner };
}

function createMockJsonResponse(value, options = {}) {
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    statusText: options.statusText || 'OK',
    headers: {
      entries() {
        return Object.entries(options.headers || { 'content-type': 'application/json' });
      }
    },
    async text() {
      return JSON.stringify(value);
    }
  };
}

function findTaskRunLog(runLogs, taskId, action) {
  return Array.isArray(runLogs)
    ? [...runLogs].reverse().find((log) => log.taskId === taskId && log.action === action) || null
    : null;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
