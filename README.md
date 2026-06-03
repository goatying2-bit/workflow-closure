# workflow-closure

AI Agent 工作流引擎。通过 CLI 命令管理任务状态机，支持单 Agent 执行、多阶段链式执行和多 Agent 协作。

## 端口归属

| Port | Service | Frontend | Backend | Isolation rule |
|------|---------|----------|---------|----------------|
| `3001` | workflow-closure ops panel | admin UI | admin API / SSE | 只给 workflow-closure 使用，不和其他独立项目混用 |

默认 ops 地址是 `http://127.0.0.1:3001`。端口、host、URL 相关配置只改 `server/admin-server-config.js`，不要在前端、脚本或测试里散落硬编码。

## 核心机制

### 任务状态机

```
pending → ready → doing → done
            ↑      ↓
            └──── blocked
pending ─────────→ skipped  （条件依赖为 false）
```

| 状态 | 含义 |
|------|------|
| pending | 等待依赖完成 |
| ready | 可以领取执行 |
| doing | 已被领取，正在执行 |
| done | 执行完成 |
| blocked | 执行受阻，需要恢复 |
| skipped | 条件依赖为 false，分支被关闭，不再执行 |

### 关键规则

1. **先领取后执行** — 必须 `claim` 才能 `complete` 或 `block`
2. **单任务执行** — 同一 workflow 同时只能有一个 `doing` 任务
3. **身份校验** — `heartbeat` 和 `complete` 必须匹配 `leaseOwner`
4. **租约过期** — `lease` 到期后任务自动释放，其他 Agent 可领取
5. **错误保留** — `block` 后 `resume`，`lastError` 保留供下次执行参考

## Workflow 运行路径

后续处理 workflow 时，先按任务规模选择运行路径，不要所有事情都直接开复杂链路。

### 路径选择

| 场景 | 推荐路径 | 数据口径 | 说明 |
|------|----------|----------|------|
| 小修、小验证、一次性排查 | `create-coding-workflow` 或 `create-workflow` → `run-next-task` | 默认 workspace DB | 追求快，闭环小，验证 targeted |
| 多阶段任务，如调研→实现→验证 | `create-chain` → `run-next-stage` / `run-chain` | 默认 workspace DB；重要项目用 `dbProfile` | 阶段之间用 handoff/outputs 交接 |
| 多角色/多 agent 协作 | `register-agent` → `assign-next-work` → `run-next-assignment` | 真实业务优先 `dbProfile` | 通过 role/capabilities 匹配 agent，不手工绕过 coordinator |
| 长任务、真实业务、需要隔离 | 带 `dbProfile` 创建/运行 workflow | 独立 profile DB | 恢复、查询、ops panel 都必须保留同一个 profile |
| 失败恢复/新窗口续跑 | ops panel recovery command 或 `resume-session` | 按 runtime selector 保留 | 恢复优先级：`dbProfile` → explicit `dbPath` → `workspacePath` |
| 从中间节点重跑 | `restart-from-task` 或 `restart-chain-from-stage` | 沿用原 runtime 数据口径 | 不手工改旧任务状态，保留 revision/rerun 记录 |

### 标准操作顺序

1. **先定数据口径**：小任务用默认 workspace DB；真实业务、长期项目、需要隔离的数据用 `dbProfile`；只有迁移/外部托管才用 explicit `dbPath`。
2. **再建 workflow/chain**：普通任务用 `create-workflow`；编码任务用 `create-coding-workflow`；多阶段业务用 `create-chain`；可复用流程先沉淀成 `workflow definition`。
3. **运行时只走 runner/coordinator**：单 workflow 用 `run-next-task`；chain 用 `run-next-stage` / `run-chain`；多 agent 用 coordinator 的 assign/run/resume 命令。
4. **执行结果必须结构化写回**：完成时写 `doneSummary`、`taskOutputs`、`payload.outputs`、`handoff`；不要只把结果留在聊天窗口。
5. **阻塞要显式 block**：遇到缺信息、验证失败、外部依赖时返回/调用 `blocked`，写清 `blockedReason`，后续用 `resume-task` / `resume-assigned-work` / `resume-session` 恢复。
6. **验证要跟 workflow policy 对齐**：coding workflow 默认 `small_loop + targeted verification`；跨边界或真实业务才扩大验证范围。
7. **恢复必须保留 runtime selector**：新窗口恢复时不要只带 `workflowId`，还要保留 `dbProfile` / `dbPath` / `workspacePath`，否则可能查到另一份 DB。
8. **结束前查状态**：用 `get-workflow-state`、`get-chain-state` 或 ops panel 确认最终状态、输出、handoff、blocked 项。

### 不要做的事

- 不要直接改 SQLite 里的任务状态来“修复” workflow；优先用 `resume`、`restart`、`release-expired-leases`、`sweep-task-timeouts`。
- 不要让真实业务数据混进默认全局 DB；需要长期保留或隔离时使用 `dbProfile`。
- 不要绕过 `claim` 直接 `complete`；任务所有权靠 leaseOwner 校验。
- 不要在前端或临时脚本里重新拼一套 DB/profile 规则；复用 runtime metadata 和 `storage/db-scope-config.js` 的口径。

### 运行层修改入口

- 状态机规则：`core/workflow-engine.js`
- runner 执行闭环、timeout、adapter 调用：`runner/workflow-runner.js`
- chain 阶段推进：`runner/workflow-chain.js`
- coordinator 分配/执行/恢复：`runner/multi-agent-coordinator.js` 和 `runner/coordinator/*`
- prompt / policy 注入：`runner/prompt-builder.js`、`core/coding-planner.js`
- 输出捕获与 artifact 落盘：`runner/task-capture.js`
- CLI 命令入口：`cli.js`
- ops panel 观察与恢复：`server/admin-server.js`、`server/admin/app.js`

### 运行层最小验证

改 workflow 运行链路后，至少运行相关组合：

```bash
npm run cli-smoke-test
npm run runner-smoke-test
npm run workflow-chain-smoke-test
npm run multi-agent-smoke-test
npm run coding-workflow-smoke-test
npm run admin-ui-smoke-test
```

涉及 timeout、lease、恢复或并发时，再加：

```bash
npm run concurrency-stress-test
npm run stale-lock-smoke-test
```

## Workflow 使用手册

Workflow 是最小可恢复执行单元：它把一条指令拆成带依赖的任务图，由 runner / coordinator 领取任务、执行 adapter、写回结构化结果，并通过 DB selector、memory/context scope、pollution boundary 保持可恢复和可隔离。

### 对象模型

| 对象 | 作用 | 关键字段 |
|------|------|----------|
| workflow instance | 一次真实运行实例 | `workflowId`、`instruction`、`plan`、`metadata`、任务状态 |
| workflow definition | 可复用模板 | `definitionId`、`name`、`instruction`、`plan`、`metadata` |
| plan step / task | 可领取执行的节点 | `key`、`title`、`description`、`contract`、`status`、`leaseOwner` |
| dependency | 任务之间的前置关系 | `from`、`to`、可选条件表达式 |
| task output | 下游可读的结构化结果 | `kind`、`title`、`content`、`metadata`、`artifactRef` |
| handoff | 阶段/agent 之间的交接摘要 | 当前结论、未完成项、下游注意事项 |
| run log / revision | 恢复和审计记录 | adapter payload、blocked reason、rerun/revision 信息 |

最重要的边界：聊天窗口不是状态源。任务结论、产物路径、失败原因、handoff 都要写回 workflow DB，后续恢复只信 DB 和结构化 outputs。

### 入口选择

| 要做什么 | 用哪个入口 | 适用边界 |
|----------|------------|----------|
| 临时拆一条普通任务 | `create-workflow` | 小任务、一次性排查 |
| 编码任务，需要自动补 inspect/implement/validation | `create-coding-workflow` | 代码修改、targeted verification |
| 从 JSON / 文档 / 自定义 source 导入任务 | `create-workflow` + `taskSourceFile` / `taskSourceModule` | 外部任务源接入 |
| 同一类流程反复运行 | `create-workflow-definition` → `create-workflow-from-definition` | 固化 SOP、发布检查、巡检 |
| 多阶段业务推进 | `create-chain` | 调研→实现→验证→交付 |
| 多 agent 分工 | coordinator commands | 角色/能力匹配、并行协作 |

真实项目、长期任务、客户/业务数据不要裸用默认 DB。先调用 `resolvePollutionBoundary()`，再把 `boundary.db`、`boundary.memory`、`boundary.context`、`boundary.workflowHygieneMetadata` 接进去。

### 动态 Runtime Resolver

调用方不应该在每个入口各自判断 workflow / coding workflow / chain / coordinator、DB profile、验证范围和清理策略。先用 `resolveWorkflowRuntime()` 生成统一运行建议，再把返回值接到创建和运行流程。

```js
import { resolveWorkflowRuntime } from 'workflow-closure';

const runtime = resolveWorkflowRuntime({
  instruction: '修复 runner 超时恢复并验证 CLI',
  workspacePath: '/workspace/workflow-closure',
  projectKey: 'workflow-closure',
  temporary: true,
  changedFiles: ['runner/workflow-runner.js', 'cli.js'],
  packageScripts: {
    'runner-smoke-test': 'node ./scripts/runner-smoke-test.js',
    'cli-smoke-test': 'node ./scripts/cli-smoke-test.js'
  }
});

runtime.workflowMode      // workflow | coding-workflow | chain | coordinator
runtime.closureMode       // small_loop | large_loop
runtime.boundary          // DB / memory / context / hygiene metadata
runtime.validation        // selected validation commands and warnings
runtime.runtimePolicy     // verification/doc/cleanup/recovery policy
runtime.runnerOptions     // 可传给 runner 的运行选项骨架
runtime.coordinatorOptions // 可传给 coordinator 的运行选项骨架
runtime.createOptions     // 创建 workflow 时应写入的 metadata/validation 信息
```

CLI 只做解析和输出，不创建 workflow、不执行任务：

```bash
node cli.js resolve-workflow-runtime --input-file ./runtime-input.json
```

第一版规则是确定性启发式：显式 `workflowMode` 优先；代码变更走 `coding-workflow`；多阶段/高风险走 `chain`；多 agent/需要协调走 `coordinator`；真实 `real/keep` 数据建议使用 `dbProfile`；临时任务通过污染边界自动变成 `test/ephemeral`。后续如果要继续动态化，应扩展这个 resolver，而不是在 CLI、runner、ops panel 或临时脚本里重复判断。

反例：

- CLI 里按一套规则选 `dbProfile`，ops panel 再按另一套规则恢复。
- 调用方自己选了 `chain`，但 validation/context/cleanup 仍按小任务处理。
- 真实项目没走 resolver，导致 memory/context scope 和 DB scope 不一致。

### 最小单 Agent 生命周期

```bash
# 1. 创建 workflow
node cli.js create-workflow --input-file ./workflow-input.json

# 2. 观察任务图和 ready 任务
node cli.js get-workflow-state --input '{"workflowId":"<workflow-id>"}'

# 3. 由 runner 自动领取并执行一个 ready 任务
node cli.js run-next-task --input '{"workflowId":"<workflow-id>","runnerId":"agent-1","leaseMs":600000}'

# 4. 循环执行，直到没有 ready 任务或出现 blocked
node cli.js run-next-task --input '{"workflowId":"<workflow-id>","runnerId":"agent-1"}'

# 5. 收尾检查
node cli.js get-workflow-state --input '{"workflowId":"<workflow-id>"}'
```

只在需要人工/外部系统执行时才手工 `claim-next-ready-task`、`complete-task`、`block-task`。常规 agent 执行优先用 `run-next-task`，避免忘记 lease、outputs 或 lifecycle 写回。

### Public API 接线模板

```js
import {
  createWorkflowEngine,
  createWorkflowRunner,
  resolvePollutionBoundary
} from 'workflow-closure';

const boundary = resolvePollutionBoundary({
  projectKey: 'client-audit',
  dbProfile: 'client-audit',
  workspacePath: 'F:/linshi1/client-audit',
  sessionId: 'audit-001',
  dataClass: 'real',
  retention: 'keep'
});

const engine = await createWorkflowEngine({
  dbPath: boundary.db.dbPath,
  workspacePath: boundary.workspacePath,
  memory: boundary.memory,
  context: boundary.context
});

const created = engine.createWorkflowFromInstruction({
  instruction: '完成客户审计资料整理',
  plan: {
    goal: '完成客户审计资料整理',
    steps: [
      { key: 'inspect', title: '检查资料', description: '读取输入资料并列出缺口。' },
      { key: 'summarize', title: '生成摘要', description: '输出审计摘要和待确认问题。' }
    ],
    dependencies: [{ from: 'inspect', to: 'summarize' }],
    metadata: boundary.workflowHygieneMetadata
  }
});

const runner = await createWorkflowRunner({
  dbPath: boundary.db.dbPath,
  workflowId: created.workflow.workflowId,
  workspacePath: boundary.workspacePath,
  memory: boundary.memory,
  context: boundary.context,
  runnerId: 'agent-1',
  adapter
});

await runner.runOnce();
```

恢复新窗口时保存并复用：

```js
boundary.db.recoverySelector
// 优先 dbProfile，其次 explicit dbPath，再其次 workspacePath
```

### 输入 plan 结构

最小 plan：

```json
{
  "instruction": "整理发布检查清单",
  "plan": {
    "goal": "整理发布检查清单",
    "steps": [
      { "key": "inspect", "title": "检查变更", "description": "读取变更范围。" },
      { "key": "verify", "title": "选择验证", "description": "给出最小验证命令。" }
    ],
    "dependencies": [
      { "from": "inspect", "to": "verify" }
    ],
    "metadata": {
      "dataClass": "real",
      "retention": "keep"
    }
  }
}
```

`key` 是稳定任务标识，后续 restart、依赖、handoff 都会引用它；不要用会随标题变化的临时文本当 key。

### 输出与 handoff 契约

adapter / runner 完成任务时，至少写回这些信息：

```json
{
  "status": "done",
  "doneSummary": "已检查 3 个配置文件，发现 recovery selector 缺失。",
  "taskOutputs": [
    {
      "kind": "finding",
      "title": "恢复口径缺失",
      "content": "ops panel 只传 workflowId，未传 dbProfile。",
      "metadata": { "severity": "medium" }
    }
  ],
  "payload": {
    "outputs": [
      { "type": "handoff", "summary": "下一步修复 recovery selector 传递。" }
    ]
  },
  "handoff": {
    "summary": "恢复路径问题已定位。",
    "next": ["修复 selector", "运行 admin-ui-smoke-test"]
  }
}
```

规则：

- `doneSummary` 给人快速读状态。
- `taskOutputs` 给下游任务、memory/context、artifact routing 使用。
- `payload.outputs` 保留 adapter 的结构化返回。
- `handoff` 写下一阶段/下一 agent 必须知道的内容。
- 大文本、报告、生成文件走 task output artifact；不要只写在日志或聊天里。

### Block / Resume / Restart

| 情况 | 正确动作 | 不要做 |
|------|----------|--------|
| 缺输入、缺权限、外部服务不可用 | `block-task` / runner 返回 `blocked`，写 `blockedReason` | 标记 done 后在 summary 里说“未完成” |
| 用户补充信息后继续 | `resume-task` 或 `resume-assigned-work` | 新建一个相同 workflow 掩盖旧 blocked |
| 中间任务逻辑错，需要从该节点重跑 | `restart-from-task` | 手工把下游任务改回 pending |
| chain 某阶段需要重跑 | `restart-chain-from-stage` | 直接删阶段输出 |
| doing 卡住或 lease 过期 | `release-expired-leases` / `sweep-task-timeouts` | 直接改 SQLite |

`block` 不是失败终态，而是可恢复断点。`restart` 会保留 revision/rerun 记录，适合需要审计和回放的真实任务。

### 真实项目 recipe

```js
const boundary = resolvePollutionBoundary({
  projectKey: 'gaokao-volunteer-system',
  dbProfile: 'gaokao-volunteer-system',
  workspacePath: 'F:/linshi1/gaokao-volunteer-system',
  sessionId: 'case-001',
  dataClass: 'real',
  retention: 'keep'
});
```

使用要求：

1. workflow / runner / coordinator 全部使用同一个 `boundary.db.dbPath`。
2. plan metadata 写入 `boundary.workflowHygieneMetadata`。
3. memory/context 复用 `boundary.memory`、`boundary.context`。
4. 恢复命令携带 `boundary.db.recoverySelector`。
5. 运行产物默认不自动清理，清理前先用 data hygiene 审计。

### 临时任务 recipe

```js
const boundary = resolvePollutionBoundary({
  projectKey: 'quick-smoke',
  workspacePath: '/workspace/workflow-closure',
  temporary: true
});
```

临时任务默认是 `test/ephemeral`：默认列表可隐藏，artifact 可作为清理候选，适合 smoke、debug、实验链路。临时任务不要复用真实项目的 `dbProfile`。

### 验证与结束检查

workflow 收尾至少确认三件事：

1. `get-workflow-state` 没有意外的 `ready` / `doing` / `blocked`。
2. 关键任务有 `doneSummary`、`taskOutputs` 或 `handoff`。
3. 数据口径正确：真实任务在独立 `dbProfile`，临时任务是 `test/ephemeral`。

如果改了 workflow 引擎、runner、输出捕获、context/memory 或污染层，按上面的“运行层最小验证”选择最小相关 smoke，不要默认全量长跑。

### Workflow 反例

- 只创建 workflow，不跑 `get-workflow-state` 做结束检查。
- adapter 只返回自然语言，不返回 `taskOutputs` / `handoff`。
- 新窗口恢复只带 `workflowId`，丢掉 `dbProfile` / `dbPath` / `workspacePath`。
- 真实项目和 smoke test 共用同一个长期 profile。
- 失败后新建 workflow 重做，导致旧 workflow 永久 blocked 且没有解释。
- 为了“修干净”直接改 DB 状态或删除 artifacts，而不是走 resume/restart/hygiene。

## 污染层边界

workflow-closure 的污染控制分为 5 层，机器可读版本在 `runner/pollution-policy.js`，内部 API 可通过 `workflow-closure/internal.js` 读取 `listPollutionPolicyLayers()`。

| 层级 | 边界 | 入口 | 作用 |
|------|------|------|------|
| L1 来源分级 | context input | `runner/context-hygiene.js` | 给 task output、memory、context item 标记 `authoritative`、`validated`、`workflow-generated`、`reference`、`recovery-only`、`quarantined`，决定基础信任级别。 |
| L2 Prompt 过滤 | prompt input | `runner/prompt-builder.js` | 只把 `promptAllowed` 的上下文放进 prompt；验证失败证据默认只给 repair task 使用。 |
| L3 持久化净化 | DB / memory / context / checkpoint | `runner/pollution-gateway.js` | 写入前隔离 raw upstream diagnostics、502、`upstream_error`、stdout/stderr 等瞬态脏 payload。 |
| L4 输出与文件边界 | workspace files | `runner/task-capture.js`、`storage/workflows.js` | 把结构化结果写成 task outputs / artifacts，路径必须留在 workspace 内，写入 metadata `artifactRef`、`storageStatus`。 |
| L5 保留与清理 | runtime data lifecycle | `storage/data-hygiene.js`、`scripts/data-hygiene.js`、`.gitignore` | 区分 `real/test/debug/unknown` 和 `keep/ephemeral/ttl`，默认隐藏测试数据，审计/清理运行产物。 |

原则：L1-L3 管“内容是否可信、能否进入 prompt/持久化”，L4-L5 管“文件和数据生命周期是否污染工作区”。新增污染规则时先判断属于哪一层，不要在调用点临时补丁。

### 统一边界接口：`resolvePollutionBoundary()`

独立项目或临时任务不要手工拼 `dbProfile`、`memory`、`context`、`dataClass`、`retention`。先调用 `resolvePollutionBoundary()`，再把返回值接到 workflow / runner / coordinator。

```js
import {
  createWorkflowEngine,
  createWorkflowRunner,
  resolvePollutionBoundary
} from 'workflow-closure';

const boundary = resolvePollutionBoundary({
  projectKey: 'gaokao-volunteer-system',
  dbProfile: 'gaokao-volunteer-system',
  workspacePath: 'F:/linshi1/gaokao-volunteer-system',
  sessionId: 'case-001',
  dataClass: 'real',
  retention: 'keep'
});

const engine = await createWorkflowEngine({
  dbPath: boundary.db.dbPath,
  workspacePath: boundary.workspacePath,
  memory: boundary.memory,
  context: boundary.context
});

const workflow = engine.createWorkflowFromInstruction({
  instruction: '整理真实业务任务',
  plan: {
    goal: '整理真实业务任务',
    steps: [{ key: 'inspect', title: '检查现状', description: '检查项目资料。' }],
    dependencies: [],
    metadata: boundary.workflowHygieneMetadata
  }
});

const runner = await createWorkflowRunner({
  dbPath: boundary.db.dbPath,
  workflowId: workflow.workflow.workflowId,
  workspacePath: boundary.workspacePath,
  memory: boundary.memory,
  context: boundary.context,
  runnerId: 'agent-1',
  adapter
});
```

返回结构重点字段：

| 字段 | 用途 | 接到哪里 |
|------|------|----------|
| `boundary.db.dbPath` | 已按 `dbProfile → dbPath → workspacePath → default` 解析好的 SQLite 路径 | `createWorkflowEngine()`、`createWorkflowRunner()`、coordinator runtime options |
| `boundary.db.recoverySelector` | 新窗口恢复时保持原数据口径 | ops panel recovery command、`resume-session` 入参 |
| `boundary.memory` | memory scope / projectKey / workspacePath / sessionId | runner / coordinator 的 `memory` 选项 |
| `boundary.context` | context scope / projectKey / workspacePath / sessionId | runner / coordinator 的 `context` 选项 |
| `boundary.workflowHygieneMetadata` | `dataClass`、`retention`、boundary version 和 projectKey | workflow plan metadata |
| `boundary.artifactPolicy` | artifact 是否 cleanable、workspace 文件边界 | 产物策略判断；文件实际写入仍由 task output routing 执行 |
| `boundary.cleanupPolicy` | 哪些 runtime target 可作为清理候选 | `scripts/data-hygiene.js` 审计/清理前的判断依据 |

### 独立项目接入

真实业务、长期项目、需要恢复的任务用独立 profile：

```js
const boundary = resolvePollutionBoundary({
  projectKey: 'client-audit',
  dbProfile: 'client-audit',
  workspacePath: 'F:/linshi1/client-audit',
  sessionId: 'audit-2026-04-29',
  dataClass: 'real',
  retention: 'keep'
});
```

效果：

- DB 使用 `isolated-db-profile`
- memory/context 限定在同一 `projectKey + workspacePath + sessionId`
- workflow metadata 标记为 `real/keep`
- recovery selector 优先保留 `dbProfile`
- artifact 不默认视为可自动清理

### 临时任务接入

一次性 smoke、排查、实验任务用 `temporary: true`：

```js
const boundary = resolvePollutionBoundary({
  projectKey: 'quick-smoke',
  workspacePath: '/workspace/workflow-closure',
  temporary: true
});
```

默认得到：

```js
boundary.workflowHygieneMetadata.dataClass === 'test'
boundary.workflowHygieneMetadata.retention === 'ephemeral'
boundary.artifactPolicy.cleanable === true
boundary.cleanupPolicy.autoCleanCandidates // ['artifacts', 'storage/test-workspaces']
```

临时任务仍可使用 workspace DB，但不会伪装成真实业务数据；默认 workflow 列表会隐藏 test/debug/archived 数据，运行产物可通过 data hygiene 审计。

### 不要这样接

```js
// 不要：真实业务没有 dbProfile，容易混进默认 DB
createWorkflowEngine({ workspacePath: 'F:/linshi1/client-audit' });

// 不要：只传 dbPath，不传 memory/context，后续 recall 可能跨项目混入
createWorkflowRunner({ dbPath, workflowId, adapter });

// 不要：临时任务忘记 dataClass/retention，后续默认列表和清理无法判断
createWorkflowFromInstruction({ instruction: 'debug smoke' });
```

正确做法是：先 `resolvePollutionBoundary()`，再复用 `boundary.db`、`boundary.memory`、`boundary.context`、`boundary.workflowHygieneMetadata`。

### 自动检测与边界

当前自动化是“边界拦截”，不是统一污染事件总线：

| 污染/风险 | 自动处理 |
|----------|----------|
| upstream 502 / `upstream_error` / raw diagnostic payload | L3 自动 quarantine，写入 sanitized payload |
| `failed` / `tainted` / `superseded` task output 进入 prompt | L1/L2 自动阻止 |
| failed validation evidence 被普通任务复用 | L2 自动阻止，只给 repair task |
| artifact path 逃出 workspace | L4 自动报错阻止 |
| 缺 workspace/content 的 artifact | L4 标记 `storageStatus=skipped` |
| test/debug workflow 默认出现在列表 | L5 默认隐藏 |
| runtime artifacts 污染 Git status | L5 通过 `.gitignore` 隔离，并由 `scripts/data-hygiene.js --runtime-artifacts` 审计 |

尚未提供统一 `detectPollution()` / `recordPollutionIncident()` 事件接口；如果后续需要跨层统计污染事件，应在 `runner/pollution-policy.js` 旁新增事件记录层，而不是把事件逻辑塞进 prompt builder 或 storage。

## 错误反省与防复发

错误反省不是事后写一句“已修复”，而是要把错误沉淀成下一次能直接排查的规则：**现象 → 原因 → 修复 → 防复发验证**。

### 记录格式

| 字段 | 要写清楚什么 |
|------|--------------|
| 现象 | 用户或测试看到的问题，例如命令报错、UI 显示不对、恢复查不到数据 |
| 原因 | 真正出错的配置归属、数据口径、状态流转或前后端边界 |
| 修复 | 改了哪个配置 home、runner、CLI、前端或测试 |
| 防复发 | 增加或确认了哪个 smoke test、syntax check、文档规则 |

### 已知易错点

| 易错点 | 典型现象 | 正确处理 | 防复发验证 |
|--------|----------|----------|------------|
| import 的 helper 又在本地重复声明 | ESM 报 `Identifier has already been declared` | 删除本地重复实现，复用配置 home 导出的 helper | `node --check cli.js` |
| 前端写死本机路径 | ops panel recovery command 只能在某台机器可用 | 后端 runtime metadata 提供 `cliPath`，前端只读 `runtime.cliPath` | `admin-ui-smoke-test` 断言不含 repo-specific path |
| 浏览器直接 import Node-only 模块 | 前端加载失败或 bundler 不存在 | 无 bundler 的前端保留轻量 mirror，并用 smoke test 校验与 Node 侧口径一致 | `node --check server/admin/app.js` + `admin-ui-smoke-test` |
| recovery 丢失数据口径 | 新窗口只带 `workflowId`，查到另一份 DB 或查不到 workflow | 恢复 selector 必须按 `dbProfile` → explicit `dbPath` → `workspacePath` 保留 | `cli-smoke-test`、ops panel recovery 断言 |
| API route 前后端各拼一套 | 按钮请求 404 或 SSE 路径漂移 | Node 侧改 `server/admin-api-routes.js`，浏览器镜像同步 `server/admin/api-routes.js` | `admin-ui-smoke-test` |
| 端口/URL 到处硬编码 | 默认地址或 `HOST` / `PORT` 覆盖失效 | 只改 `server/admin-server-config.js`，消费者调用 resolver/builder | syntax check + ops panel 手动验证 |
| README 插入新段落破坏原标题 | CLI 表格失去所属章节，后续读文档找不到入口 | 插入后读相邻段落，确认标题层级还在 | 读 README 相关区间 |

### 处理原则

1. 先把错误归类到四个配置 home 或 workflow 运行层入口，避免在调用处临时补丁。
2. 每次修复都至少补一条验证：syntax check、smoke test、或 README 规则。
3. 涉及数据恢复时，优先检查 runtime selector 是否保留；不要先怀疑 workflowId。
4. 涉及前端时，先分清是浏览器静态文件、API route、后端 payload、还是 server config。
5. 不直接改 SQLite 状态来掩盖错误；使用现有 resume/restart/release/sweep 命令留下可追踪记录。

## CLI 命令

### Workflow

| 命令 | 用途 | 关键输入 |
|------|------|---------|
| `draft-plan` | 根据指令生成执行计划 | `instruction` |
| `create-workflow` | 创建工作流 | `instruction`, `plan` |
| `create-workflow-definition` | 保存可复用 workflow definition | `name`, `instruction`, `plan` |
| `get-workflow-definition` | 查询单个 workflow definition | `definitionId` |
| `list-workflow-definitions` | 列出 workflow definitions | `search`, `sourceWorkflowId`, `limit` |
| `create-workflow-from-definition` | 基于 definition 创建 workflow 实例 | `definitionId` |
| `draft-coding-plan` | 根据编码指令生成 coding workflow 计划 | `instruction`, `changedFiles`, `packageScripts` |
| `create-coding-workflow` | 创建带编码步骤和验证要求的工作流 | `instruction`, `changedFiles`, `plan` |
| `select-validation` | 根据显式变更文件选择验证命令，不执行命令 | `changedFiles`, `packageScripts`, `profile` |
| `get-workflow-state` | 查询工作流状态 | `workflowId` |
| `list-workflow-reruns` | 查询 workflow 重跑记录 | `workflowId` |
| `list-task-revisions` | 查询任务修订历史 | `workflowId`, `taskId` |
| `list-descendant-task-ids` | 查询下游任务 | `workflowId`, `taskId` |
| `restart-from-task` | 从指定任务重跑 | `workflowId`, `taskId`, `reason` |
| `claim-next-ready-task` | 领取就绪任务 | `leaseOwner`, `leaseMs` |
| `heartbeat-task-lease` | 续租任务 | `workflowId`, `taskId`, `leaseOwner` |
| `complete-task` | 完成任务 | `workflowId`, `taskId`, `doneSummary` |
| `block-task` | 阻塞任务 | `workflowId`, `taskId`, `blockedReason` |
| `resume-task` | 恢复阻塞任务 | `workflowId`, `taskId` |
| `release-expired-leases` | 释放过期租约 | `reason` |
| `sweep-task-timeouts` | 扫描并回收/阻塞超时 doing 任务 | `workflowId`, `maxExecutionMs`, `stalledMs`, `maxAttempts`, `reason` |

### Chain（多阶段工作流）

| 命令 | 用途 |
|------|------|
| `create-chain` | 创建阶段链 |
| `get-chain-state` | 查询阶段链状态 |
| `run-chain` | 执行整个链 |
| `run-next-stage` | 执行下一阶段 |
| `resume-chain-stage` | 恢复阻塞阶段 |
| `restart-chain-from-stage` | 从指定阶段重跑 |

### Coordinator（多 Agent 协作）

| 命令 | 用途 |
|------|------|
| `register-agent` | 注册 Agent |
| `get-coordinator-state` | 查询协调器状态 |
| `assign-next-work` | 分配任务给 Agent |
| `run-next-assignment` | 执行分配 |
| `resume-assigned-work` | 恢复阻塞的分配 |

### Runner

| 命令 | 用途 |
|------|------|
| `run-next-task` | 由 runner 自动领取并推进下一个任务 |

`run-next-task` 除了 `workflowId`、`runnerId`、`leaseMs`、`maxTaskRetries` 之外，还支持以下 timeout runtime 参数：

- `taskExecutionTimeoutMs`：单次 adapter 执行超时阈值；超过后当前执行按 runner timeout 处理
- `timeoutSweepMaxExecutionMs`：把处于 `doing` 且执行时长超过阈值的任务视为超时
- `timeoutSweepStalledMs`：把长时间未推进的 `doing` 任务视为 stalled
- `timeoutSweepMaxAttempts`：超时任务最多自动回收几次；耗尽后转为 `blocked`
- `timeoutSweepIntervalMs`：runner 自动 sweep 的最小间隔，用于节流多轮 loop
- `timeoutSweepReason`：自动 sweep 写入任务/日志的原因文本

如果 task `contract` 里显式声明了 `executionTimeoutMs`、`stalledTimeoutMs`、`maxTimeoutAttempts` 或 `timeoutReason`，则这些 task 级策略优先于 runner runtime 默认值；runner 传入的 timeout 参数只作为未声明 task policy 时的默认兜底。

当配置了 `timeoutSweepMaxExecutionMs` 或 `timeoutSweepStalledMs` 后，runner 每次 `run-next-task` / `runOnce()` 会先执行自动 maintenance：

1. 按 `timeoutSweepIntervalMs` 节流执行 timeout sweep
2. 自动释放过期 lease
3. 再 claim 下一个 ready 任务

因此 timeout 管理现在是自动闭环的：超时或 stalled 的 `doing` 任务不需要再依赖外部手工维护就能回到 `ready`，或在达到 `timeoutSweepMaxAttempts` 后自动转成 `blocked`。

`sweep-task-timeouts` 命令仍然保留，适合一次性运维补扫、手工补救或离线维护；它和 runner 自动 maintenance 复用同一套底层状态流转逻辑。

## 输入方式

CLI 支持四种结构化输入方式：

- `--input '<json>'`
- `--input-file ./input.json`
- `--input-stdin`
- `--input-file -`（把 stdin 当作 input file 读取）

推荐优先级：

1. `--input-file ./input.json`：最稳妥，适合复杂 JSON
2. `--input-stdin`：适合管道或 PowerShell/CI
3. `--input-file -`：适合希望复用 file 语义但实际从 stdin 送入内容
4. `--input '<json>'`：仅适合简单、短小的 inline JSON

`create-workflow` 除了直接传 `instruction` / `plan`，也支持通过 task source 输入：

- `taskSourceFile` / `taskSourcePath`
  - `.json`：按结构化 task source 真正导入 workflow
  - `.doc` / `.docx` / `.pdf` / `.ppt` / `.pptx`：当前仅做 placeholder 兼容，表示文件可以接入 workflow 主链路，不表示正文已经被准确解析
- `taskSourceModule`：加载自定义 JS task source module

## Quick examples

```bash
npm install

# 创建工作流
node cli.js create-workflow --input '{"instruction":"实现登录功能"}'

# 通过 JSON task source 创建工作流
node cli.js create-workflow --input '{"taskSourceFile":"./workflow.json"}'

# 通过文档文件创建 placeholder workflow
node cli.js create-workflow --input '{"taskSourceFile":"./brief.pdf","instruction":"审阅 PDF 并整理任务"}'

# 通过 stdin 创建 workflow
printf '%s' '{"instruction":"通过 stdin 创建 workflow"}' | node cli.js create-workflow --input-stdin

# 通过 --input-file - 从 stdin 创建 workflow
printf '%s' '{"instruction":"通过 stdin file alias 创建 workflow"}' | node cli.js create-workflow --input-file -

# 领取下一个 ready 任务
node cli.js claim-next-ready-task --input '{"leaseOwner":"agent-1","leaseMs":60000}'

# 完成任务（需要 workflowId 和 taskId）
node cli.js complete-task --input '{"workflowId":"<workflow-id>","taskId":"<task-id>","doneSummary":"已实现"}'
```

## Workflow definitions

workflow definition 是可复用的 workflow 模板。它和 workflow instance 分离：

- definition 持久化保存 `instruction`、`goal`、`plan`、`metadata`
- instance 每次由 definition 派生，拥有自己的 `workflowId`、任务状态和运行日志
- 适合同一类任务重复执行，而不是每次重新 `create-workflow`

```bash
# 保存一个可复用 definition
node cli.js create-workflow-definition --input-file ./definition.json

# 查询 definition
node cli.js get-workflow-definition --input '{"definitionId":"release-checklist"}'

# 搜索/列出 definition
node cli.js list-workflow-definitions --input '{"search":"release","limit":10}'

# 基于 definition 创建 workflow 实例
node cli.js create-workflow-from-definition --input '{"definitionId":"release-checklist","workflowId":"release-checklist-001"}'
```

`create-workflow-definition` 常用字段：

- `definitionId`：可选；不传则自动生成
- `name`：必填；definition 名称
- `description`：可选；给人看的说明
- `instruction` / `goal` / `plan`：definition 主体
- `metadata`：可选；附加结构化元数据
- `sourceWorkflowId`：可选；记录该 definition 来源于哪个 workflow

Coding workflow 是在通用 workflow 之上的编码任务预处理层：它不会直接改代码，而是把编码指令拆成 inspect、implement、select-validation、run-validation 四个步骤，并把验证要求写入任务 contract。

```bash
# 只生成编码计划
node cli.js draft-coding-plan --input '{"instruction":"修复 verifier 选择逻辑","changedFiles":["runner/verifier.js"],"packageScripts":{"verifier-smoke-test":"node ./scripts/verifier-smoke-test.js","runner-smoke-test":"node ./scripts/runner-smoke-test.js"}}'

# 生成并创建编码工作流
node cli.js create-coding-workflow --input '{"workflowId":"coding-fix","instruction":"修复 CLI coding workflow","changedFiles":["cli.js"]}'

# 只选择验证命令，不运行
node cli.js select-validation --input '{"changedFiles":["runner/verifier.js"],"profile":"standard"}'
```

验证命令以结构化对象保存在 `task.contract.validationCommands`，例如 `command`、`args`、`script`、`cwd`、`required`、`timeoutMs`、`reason`。Prompt builder 会把这些命令渲染到任务提示中；执行器运行验证后应把证据写入 `payload.validationResults`，如果必需验证无法运行则返回 `blocked`。

### Workflow closure policy

Coding workflow 会把 workflow 级 closure policy 固化到 `workflow.initialPlan.metadata`，作为 v1 的单一真源：

- `closureMode=small_loop`
- `verificationLevel=targeted`
- `docPolicy=minimal`
- `cleanupPolicy=defer`

planner 会先写入这组默认值，并只在出现明确跨边界信号时保守升级成更大的闭环策略。wrapper / runner 在执行期统一读取这份 metadata；prompt builder 会把它渲染成 agent 执行约束；verifier 会按 `verificationLevel` 消费验证范围，并把 policy 快照写进验证证据与 runner 输出 metadata。

第一版边界：

- `workflow.initialPlan.metadata` 是唯一策略来源
- 只做静态 policy 落地，不做 mid-run 动态升级
- 不新增数据库 schema，继续复用 `initial_plan_json`

## Result-driven workflow


- `runner-result` 这类**没有显式 `path` 的输出**，只要同时具备可写 `content` 和可用 `workspacePath`，就会自动生成 `artifacts/workflows/<workflowId>/<taskId>/results/...` 路径，并在写入 SQLite 的同时落盘到 workspace。
- 如果缺少 `workspacePath`、`content` 或目标路径无效，这类输出仍会保留数据库记录，但 `storageStatus` 会标记为 `skipped`，不会实际落盘。
- 落盘成功后，output metadata 会补充 `artifactRef`、`storageStatus`、`relativePath`、`workspacePath` 等字段，形成“数据库记录 + 物理产物引用”的闭环。
- `output.path` 表示**artifact 目标路径**；`condition.path` 仍然表示**输出对象上的 JSON selector**，两者语义不同。

```js
{
  kind: 'result',
  name: 'runner-result',
  contentText: '<doneSummary 或 message>',
  metadata: {
    routingSignal: payload.routingSignal,
    handoffSummary: '<handoff.summary>',
    verificationSummary: { status, reason, reasonCode },
    checkpointSummary: { status, summary, artifactRef }
  }
}
```

Adapter 也可以通过 `payload.outputs[]` 显式写入更多输出：

```js
return {
  status: 'done',
  doneSummary: '完成并选择 reviewer 分支',
  payload: {
    routingSignal: { next: 'reviewer' },
    outputs: [
      {
        kind: 'artifact',
        name: 'decision-record',
        contentText: 'reviewer branch selected',
        path: 'artifacts/decision.txt',
        metadata: { branch: 'reviewer' }
      }
    ]
  }
};
```

Plan dependency 可以带 `condition`。后继任务只有在所有前置任务完成且条件为 true 时才会从 `pending` 变为 `ready`：

```js
{
  predecessor: 'producer',
  successor: 'reviewer',
  condition: {
    outputKind: 'result',
    outputName: 'runner-result',
    path: 'metadata.routingSignal.next',
    operator: 'equals',
    value: 'reviewer'
  }
}
```

第一版条件支持 `exists`、`equals`、`notEquals`、`includes`。条件为 false 的后继会被自动标记为 `skipped`，并记录 `dependency_condition_not_met` reasonCode。这一层只补上“结果存储 + 条件依赖”的最小闭环；chain 分支、动态角色路由、重试策略引擎仍是后续能力。


最小返回结构：

```js
export default async function adapter(input) {
  return {
    status: 'done', // 或 'blocked'
    doneSummary: '完成说明',
    blockedReason: null,
    payload: {},
    handoff: {
      summary: '交接摘要',
      artifacts: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      recommendedNextRole: null
    }
  };
}
```

单 runner 使用：

```bash
node cli.js run-next-task --adapter-module ./examples/adapters/simple-js-adapter.js --input '{"workflowId":"<workflow-id>","runnerId":"agent-1"}'
```

带自动 timeout maintenance 的 runner：

```bash
node cli.js run-next-task --adapter-module ./examples/adapters/simple-js-adapter.js --input '{"workflowId":"<workflow-id>","runnerId":"agent-1","taskExecutionTimeoutMs":300000,"timeoutSweepMaxExecutionMs":300000,"timeoutSweepMaxAttempts":2,"timeoutSweepIntervalMs":5000}'
```

多 Agent 使用：

```bash
node cli.js register-agent --input '{"agentId":"agent-1","name":"Agent 1","role":"implementer","capabilities":["implement"],"adapterModule":"./examples/adapters/simple-js-adapter.js"}'
node cli.js assign-next-work --input '{"workflowId":"<workflow-id>"}'
node cli.js run-next-assignment --input '{"workflowId":"<workflow-id>"}'
```

如果希望 agent 在执行时默认知道自己可见的工具、记忆边界和工作区约束，可以在 `register-agent` 里传入 `visibility`。它是 **execution hint**，不是 routing gate；真正决定能否接任务的仍然是 `role` / `requiredRole` 和 `capabilities` / `requiredCapabilities`。

```bash
node cli.js register-agent --input '{
  "agentId":"agent-1",
  "name":"Agent 1",
  "role":"implementer",
  "capabilities":["implement"],
  "visibility":{
    "tools":[
      {
        "name":"editor",
        "purpose":"修改当前 workspace 内的实现",
        "whenToUse":"执行 implement 任务时使用",
        "constraints":"仅修改当前 workflow workspace"
      }
    ],
    "memory":{
      "scope":"workspace",
      "projectKey":"workflow-closure",
      "workspacePath":"/workspace/workflow-closure",
      "sessionId":"agent-1-session",
      "limit":5
    },
    "workspace":{
      "cwd":"/workspace/workflow-closure",
      "writablePaths":["/workspace/workflow-closure"]
    }
  },
  "adapterModule":"./examples/adapters/simple-js-adapter.js"
}'
```

runner / coordinator 会把这些 execution hints 同时透传到：

- prompt 中的 `执行上下文` 段落
- adapter 输入里的 `executionContext`
- adapter 输入里的 `activeMemoryContext`
- context bundle 里的 `execution-tools` / `execution-memory` / `execution-workspace`

这样即使当前 recall 结果为空，agent 仍然默认知道自己应该去哪里读写记忆、当前有哪些默认工具，以及工作区边界是什么。

Claude Code adapter 可通过 `createClaudeCodeAdapter()` 复用现有 subprocess adapter：

```js
import { createClaudeCodeAdapter } from 'workflow-closure';

export default createClaudeCodeAdapter({
  command: 'claude',
  args: ['--print'],
  timeoutMs: 120_000
});
```

内建 AI provider adapter 也已提供，适合直接对接 HTTP API，而不必自己先包一层 subprocess：

```js
import {
  createAnthropicMessagesAdapter,
  createOpenAIChatCompletionsAdapter
} from 'workflow-closure';

const anthropicAdapter = createAnthropicMessagesAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-6',
  timeoutMs: 120_000
});

const openaiAdapter = createOpenAIChatCompletionsAdapter({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4.1',
  timeoutMs: 120_000
});
```

两类 provider adapter 都遵循和其他 adapter 相同的 `done | blocked` 结果契约：provider 返回的文本内容必须是一个 JSON adapter result；运行时会自动做 HTTP 请求、提取文本、校验契约，并把 provider / endpoint / model / HTTP 状态等元数据写回 adapter payload，便于后续排查。

参考示例：`examples/adapters/simple-js-adapter.js` 和 `examples/adapters/claude-code-adapter-module.js`。

## 机器可读文档

AI Agent 通过以下文件自动发现命令：

- `agent-integration-contract.json` — 命令清单和参数定义
- `cli-protocol-examples.json` — 每个命令的输入输出示例

## 数据口径

workflow-closure 把默认数据和独立数据分开命名：

- 默认 workspace 数据：不传 `dbProfile` / `dbPath` 时，按当前 `workspacePath` 解析到 `storage/workspaces/<workspace-key>/workflow-closure.db`。
- 默认全局数据：没有 workspace 时才使用 `storage/workflow-closure.db`。
- 独立 profile 数据：传 `dbProfile` 或 `profile` 时，使用 `storage/workspaces/profiles/<profile>/workflow-closure.db`，适合真实业务、长期项目或需要隔离的任务。
- 独立指定数据库：传 `dbPath` 时，直接使用该数据库文件，适合临时迁移或外部托管场景。

CLI / ops panel 会暴露 `dbPathSource` 和 `dbScopeLabel`，用于区分 `default-workspace-db`、`default-global-db`、`isolated-db-profile`、`explicit-db-path`。这些标签和恢复选择逻辑统一放在 `storage/db-scope-config.js`。

## 框架配置分区

框架配置按四个入口归档，后续改动必须先判断属于哪一类，再改对应文件，避免继续散落：

| 类别 | 入口文件 | 管什么 | 不管什么 |
|------|----------|--------|----------|
| 服务监听配置 | `server/admin-server-config.js` | admin 前端/后端默认 host、port、URL，`HOST` / `PORT` 环境变量，服务启动监听参数 | 不放具体 API route，不放 Claude runtime 参数 |
| API 路由配置 | `server/admin-api-routes.js`、`server/admin/api-routes.js` | `/api/...` 路径常量、prefix/suffix、URL builder | 不放端口，不放业务处理逻辑 |
| Runtime 执行配置 | `runtime/claude-runtime-config.js` | Claude/agent/adapter/workspace/timeout/retry 默认值，`WORKFLOW_CLOSURE_CLAUDE_*` 环境变量，默认 Claude command/args 解析 | 不放 workflow DB scope 文案，不放 admin API route |
| 数据口径配置 | `storage/db-scope-config.js`、`server/admin/db-scope-config.js` | 默认 workspace/global DB 与独立 profile/explicit DB 的标签、profile 列表、恢复 selector；浏览器镜像只放前端展示/恢复选择所需的同名标签和 helper | 不直接打开 SQLite，不决定 server 端口 |

### 后续修改规则

1. 改 admin 端口、host、ops panel URL：只改 `server/admin-server-config.js`，消费者通过 `resolveAdminServerListenOptions()` / `buildAdminServerUrl()` 读取。
2. 新增或改名后端接口：先改 `server/admin-api-routes.js`，再同步 `server/admin/api-routes.js`。前端无 bundler，不能直接 import Node 侧文件。
3. 改 Claude runtime 默认命令、参数、agent 身份、timeout、retry、`WORKFLOW_CLOSURE_CLAUDE_*`：只改 `runtime/claude-runtime-config.js`，`scripts/claude-runtime-profile.js` 只负责解析成 profile 输出。
4. 改默认数据/独立数据的命名、`dbPathSource`、`dbScopeLabel`、profile 列表、恢复命令 selector：先改 `storage/db-scope-config.js`；如果影响 ops panel 展示，再同步浏览器镜像 `server/admin/db-scope-config.js`。`storage/db.js` 只负责解析 DB 路径和打开 DB。
5. ops panel 的恢复命令不能写死本机路径；后端 runtime metadata 提供 `cliPath`，前端从 `runtime.cliPath` 生成命令。
6. 新增配置时不要顺手塞到调用处。先判断四类归属；如果不属于四类，再说明为什么需要新配置面。

### 修改后的最小验证

涉及这些配置时，至少运行：

```bash
node --check "server/admin-server-config.js"
node --check "server/admin-api-routes.js"
node --check "server/admin/api-routes.js"
node --check "server/admin/db-scope-config.js"
node --check "runtime/claude-runtime-config.js"
node --check "scripts/claude-runtime-profile.js"
node --check "storage/db-scope-config.js"
node --check "storage/db.js"
node --check "cli.js"
node --check "server/admin/app.js"
node --check "server/admin-server.js"
npm run admin-ui-smoke-test
npm run cli-smoke-test
npm run claude-runtime-smoke-test
```

预期边界：默认 ops 地址仍是 `http://127.0.0.1:3001`；`HOST` / `PORT` 仍只影响 admin server；`WORKFLOW_CLOSURE_CLAUDE_*` 仍只影响 Claude runtime profile；恢复命令按 `dbProfile` → explicit `dbPath` → `workspacePath` 保留数据口径。

## 并发控制

多 Agent 同时写入时，使用文件锁串行化：

```js
// storage/db.js
withDbLock(dbPath, () => {
  // 写入操作
});
```

## 运维面板（ops panel）

本地 ops panel 用于直接观察和操作 coordinator 状态，覆盖 Agents、Assignments、Handoffs、blocked work，以及 Resume / Reassign。

```bash
npm run ops-panel
```

默认地址：`http://127.0.0.1:3001`

当前支持的操作：

- Refresh coordinator state
- Assign next
- Run next
- Resume blocked assignment
- Reassign blocked assignment
- 查看指定 chain 的详情状态

说明：当前面板是本地运维入口，不提供鉴权、多租户隔离或生产控制台能力。

## 测试

### npm scripts

```bash
npm run smoke-test
npm run context-smoke-test
npm run memory-smoke-test
npm run memory-recall-eval
npm run runner-smoke-test
npm run verifier-smoke-test
npm run subprocess-adapter-smoke-test
npm run claude-code-adapter-smoke-test
npm run provider-adapter-smoke-test
npm run checkpoint-sink-smoke-test
npm run task-source-smoke-test
npm run rule-provider-smoke-test
npm run workflow-wrapper-smoke-test
npm run workflow-chain-smoke-test
npm run multi-agent-smoke-test
npm run cli-smoke-test
npm run result-routing-smoke-test
npm run coding-workflow-smoke-test
npm run agent-contract-smoke-test
npm run pollution-stress-test
npm run concurrency-stress-test
npm run hallucination-stress-test
npm run laziness-stress-test
npm run context-pollution-stress-test
npm run memory-stress-test
npm run memory-extreme-stress-test
npm run auto-invocation-stress-test
npm run stress-test
npm run full-smoke-test  # 运行完整 smoke + stress 回归
npm run generate-cli-protocol-examples
npm run generate-agent-integration-contract
npm run verify-agent-contract
```

## 平台说明

- CLI 通过 Node.js 运行，跨平台用法统一：`node cli.js <command>` 或安装后的 `workflow-closure <command>`
- Windows / PowerShell 下，复杂 JSON 不建议优先使用 `--input '{...}'`；更稳妥的是 `--input-file ./input.json`、`--input-stdin` 或 `--input-file -`
- `--input-stdin` 和 `--input-file -` 适合 PowerShell、CI、跨 shell 管道场景，能避开 inline JSON quoting / `&` 解析问题
- 子进程执行方式由 adapter 配置的 `command` / `args` / `cwd` / `env` 决定，而不是 CLI 自动切换 shell

## 依赖

- `better-sqlite3`
