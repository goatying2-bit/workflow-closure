# workflow-closure

**English** | [简体中文](./README.zh-CN.md)

An AI Agent workflow engine. It manages a task state machine through CLI commands and supports single-agent execution, multi-stage chained execution, and multi-agent coordination.

## Ops Panel Port

| Port | Service | Frontend | Backend | Isolation rule |
|------|---------|----------|---------|----------------|
| `3001` | workflow-closure ops panel | admin UI | admin API / SSE | Reserved for workflow-closure only; do not share with other standalone projects |

The default ops address is `http://127.0.0.1:3001`. Change port/host/URL settings only in `server/admin-server-config.js`; do not scatter hard-coded values across the frontend, scripts, or tests.

## Core Mechanism

### Task state machine

```
pending → ready → doing → done
            ↑      ↓
            └──── blocked
pending ─────────→ skipped  (conditional dependency evaluates to false)
```

| State | Meaning |
|-------|---------|
| pending | Waiting for dependencies to complete |
| ready | Available to be claimed and executed |
| doing | Claimed and currently executing |
| done | Execution complete |
| blocked | Execution blocked; needs recovery |
| skipped | Conditional dependency is false; the branch is closed and will not run |

### Key rules

1. **Claim before executing** — you must `claim` before you can `complete` or `block`.
2. **Single active task** — a workflow can have only one `doing` task at a time.
3. **Identity verification** — `heartbeat` and `complete` must match the `leaseOwner`.
4. **Lease expiry** — once a `lease` expires the task is released automatically and another agent can claim it.
5. **Error retention** — after `block` then `resume`, the `lastError` is preserved for the next execution to reference.

## Workflow Run Paths

When working with a workflow, first choose a run path based on the task size — don't push everything through the most complex pipeline.

### Choosing a path

| Scenario | Recommended path | Data scope | Notes |
|----------|------------------|------------|-------|
| Small fix, small check, one-off triage | `create-coding-workflow` or `create-workflow` → `run-next-task` | Default workspace DB | Fast, small closure, targeted verification |
| Multi-stage task (research → implement → verify) | `create-chain` → `run-next-stage` / `run-chain` | Default workspace DB; use `dbProfile` for important projects | Hand off between stages via handoff/outputs |
| Multi-role / multi-agent collaboration | `register-agent` → `assign-next-work` → `run-next-assignment` | Prefer `dbProfile` for real business | Match agents by role/capabilities; do not bypass the coordinator |
| Long task, real business, needs isolation | Create/run workflow with `dbProfile` | Isolated profile DB | Keep the same profile for recovery, queries, and the ops panel |
| Failure recovery / resuming in a new window | Ops panel recovery command or `resume-session` | Preserve per runtime selector | Recovery priority: `dbProfile` → explicit `dbPath` → `workspacePath` |
| Rerun from an intermediate node | `restart-from-task` or `restart-chain-from-stage` | Reuse the original runtime data scope | Don't manually edit old task states; keep revision/rerun records |

### Standard operating order

1. **Decide the data scope first**: small tasks use the default workspace DB; real business, long-running projects, and data needing isolation use a `dbProfile`; only migration / external hosting uses an explicit `dbPath`.
2. **Then create the workflow/chain**: ordinary tasks use `create-workflow`; coding tasks use `create-coding-workflow`; multi-stage business uses `create-chain`; reusable flows should be captured as a `workflow definition`.
3. **At runtime, go only through the runner/coordinator**: single workflow uses `run-next-task`; chain uses `run-next-stage` / `run-chain`; multi-agent uses the coordinator's assign/run/resume commands.
4. **Write results back as structured data**: on completion write `doneSummary`, `taskOutputs`, `payload.outputs`, and `handoff`; don't leave results only in the chat window.
5. **Block explicitly**: when information is missing, verification fails, or an external dependency is unavailable, return/invoke `blocked` with a clear `blockedReason`, then recover later via `resume-task` / `resume-assigned-work` / `resume-session`.
6. **Align verification with the workflow policy**: coding workflows default to `small_loop + targeted verification`; widen verification only for cross-boundary or real-business work.
7. **Recovery must preserve the runtime selector**: when resuming in a new window don't carry only `workflowId` — also keep `dbProfile` / `dbPath` / `workspacePath`, otherwise you may hit a different DB.
8. **Check state before finishing**: use `get-workflow-state`, `get-chain-state`, or the ops panel to confirm the final state, outputs, handoff, and blocked items.

### What not to do

- Don't directly edit task state in SQLite to "fix" a workflow; prefer `resume`, `restart`, `release-expired-leases`, `sweep-task-timeouts`.
- Don't let real-business data leak into the default global DB; use a `dbProfile` when you need long-term retention or isolation.
- Don't bypass `claim` to `complete` directly; task ownership relies on `leaseOwner` verification.
- Don't reinvent DB/profile rules in the frontend or throwaway scripts; reuse the runtime metadata and the scope defined in `storage/db-scope-config.js`.

### Where to change the run layer

- State machine rules: `core/workflow-engine.js`
- Runner execution loop, timeout, adapter calls: `runner/workflow-runner.js`
- Chain stage progression: `runner/workflow-chain.js`
- Coordinator assignment/execution/recovery: `runner/multi-agent-coordinator.js` and `runner/coordinator/*`
- Prompt / policy injection: `runner/prompt-builder.js`, `core/coding-planner.js`
- Output capture and artifact persistence: `runner/task-capture.js`
- CLI command entry: `cli.js`
- Ops panel observation and recovery: `server/admin-server.js`, `server/admin/app.js`

### Minimal verification for the run layer

After changing the workflow run path, run at least the relevant combination:

```bash
npm run cli-smoke-test
npm run runner-smoke-test
npm run workflow-chain-smoke-test
npm run multi-agent-smoke-test
npm run coding-workflow-smoke-test
npm run admin-ui-smoke-test
```

When timeouts, leases, recovery, or concurrency are involved, add:

```bash
npm run concurrency-stress-test
npm run stale-lock-smoke-test
```

## Workflow Manual

A workflow is the smallest recoverable unit of execution: it breaks one instruction into a dependency graph of tasks, where the runner / coordinator claims tasks, executes adapters, and writes back structured results — staying recoverable and isolated through the DB selector, memory/context scope, and pollution boundary.

### Object model

| Object | Role | Key fields |
|--------|------|------------|
| workflow instance | A single real run | `workflowId`, `instruction`, `plan`, `metadata`, task states |
| workflow definition | Reusable template | `definitionId`, `name`, `instruction`, `plan`, `metadata` |
| plan step / task | A claimable, executable node | `key`, `title`, `description`, `contract`, `status`, `leaseOwner` |
| dependency | A precedence relation between tasks | `from`, `to`, optional condition expression |
| task output | Structured result readable downstream | `kind`, `title`, `content`, `metadata`, `artifactRef` |
| handoff | Handover summary between stages/agents | Current conclusion, open items, downstream cautions |
| run log / revision | Recovery and audit record | adapter payload, blocked reason, rerun/revision info |

The most important boundary: the chat window is not the source of state. Task conclusions, artifact paths, failure reasons, and handoffs must all be written back to the workflow DB; recovery trusts only the DB and structured outputs.

### Choosing an entry point

| What you want to do | Entry point | Boundary |
|---------------------|-------------|----------|
| Break out an ad-hoc ordinary task | `create-workflow` | Small task, one-off triage |
| Coding task needing auto inspect/implement/validation steps | `create-coding-workflow` | Code changes, targeted verification |
| Import tasks from JSON / a document / a custom source | `create-workflow` + `taskSourceFile` / `taskSourceModule` | External task-source ingestion |
| Run the same kind of flow repeatedly | `create-workflow-definition` → `create-workflow-from-definition` | Fixed SOPs, release checks, inspections |
| Drive multi-stage business forward | `create-chain` | research → implement → verify → deliver |
| Divide work among multiple agents | coordinator commands | role/capability matching, parallel collaboration |

For real projects, long-running tasks, and customer/business data, don't use the default DB raw. Call `resolvePollutionBoundary()` first, then wire in `boundary.db`, `boundary.memory`, `boundary.context`, and `boundary.workflowHygieneMetadata`.

### Dynamic runtime resolver

Callers shouldn't independently decide workflow / coding-workflow / chain / coordinator, DB profile, verification scope, and cleanup policy at every entry point. Use `resolveWorkflowRuntime()` to produce one unified run recommendation, then feed its return value into the create and run flows.

```js
import { resolveWorkflowRuntime } from 'workflow-closure';

const runtime = resolveWorkflowRuntime({
  instruction: 'Fix runner timeout recovery and verify the CLI',
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
runtime.runnerOptions     // runner run-option skeleton
runtime.coordinatorOptions // coordinator run-option skeleton
runtime.createOptions     // metadata/validation to write when creating the workflow
```

The CLI only parses and prints — it does not create workflows or execute tasks:

```bash
node cli.js resolve-workflow-runtime --input-file ./runtime-input.json
```

The first version of the rules is a deterministic heuristic: an explicit `workflowMode` wins; code changes go to `coding-workflow`; multi-stage / high-risk go to `chain`; multi-agent / needs-coordination go to `coordinator`; `real/keep` data is advised to use a `dbProfile`; temporary tasks become `test/ephemeral` automatically through the pollution boundary. To make this more dynamic later, extend this resolver rather than duplicating the decision in the CLI, runner, ops panel, or throwaway scripts.

Anti-patterns:

- The CLI picks a `dbProfile` by one set of rules while the ops panel recovers by another.
- The caller chose `chain` but validation/context/cleanup are still handled as a small task.
- A real project skipped the resolver, so the memory/context scope and DB scope diverge.

### Minimal single-agent lifecycle

```bash
# 1. Create a workflow
node cli.js create-workflow --input-file ./workflow-input.json

# 2. Observe the task graph and ready tasks
node cli.js get-workflow-state --input '{"workflowId":"<workflow-id>"}'

# 3. Let the runner automatically claim and execute one ready task
node cli.js run-next-task --input '{"workflowId":"<workflow-id>","runnerId":"agent-1","leaseMs":600000}'

# 4. Loop until there are no ready tasks or one is blocked
node cli.js run-next-task --input '{"workflowId":"<workflow-id>","runnerId":"agent-1"}'

# 5. Final check
node cli.js get-workflow-state --input '{"workflowId":"<workflow-id>"}'
```

Use manual `claim-next-ready-task`, `complete-task`, and `block-task` only when a human or external system must execute. For normal agent execution prefer `run-next-task`, which avoids forgetting the lease, outputs, or lifecycle write-back.

### Public API wiring template

```js
import {
  createWorkflowEngine,
  createWorkflowRunner,
  resolvePollutionBoundary
} from 'workflow-closure';

const boundary = resolvePollutionBoundary({
  projectKey: 'client-audit',
  dbProfile: 'client-audit',
  workspacePath: '/workspace/client-audit',
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
  instruction: 'Organize client audit materials',
  plan: {
    goal: 'Organize client audit materials',
    steps: [
      { key: 'inspect', title: 'Inspect materials', description: 'Read the inputs and list gaps.' },
      { key: 'summarize', title: 'Produce summary', description: 'Output an audit summary and open questions.' }
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

Save and reuse this when recovering in a new window:

```js
boundary.db.recoverySelector
// Prefer dbProfile, then explicit dbPath, then workspacePath
```

### Input plan structure

Minimal plan:

```json
{
  "instruction": "Organize the release checklist",
  "plan": {
    "goal": "Organize the release checklist",
    "steps": [
      { "key": "inspect", "title": "Inspect changes", "description": "Read the change scope." },
      { "key": "verify", "title": "Select verification", "description": "Give the minimal verification commands." }
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

`key` is a stable task identifier referenced later by restart, dependencies, and handoffs; don't use transient text that changes with the title as the key.

### Output and handoff contract

When the adapter / runner completes a task, write back at least this information:

```json
{
  "status": "done",
  "doneSummary": "Inspected 3 config files; found the recovery selector is missing.",
  "taskOutputs": [
    {
      "kind": "finding",
      "title": "Recovery scope missing",
      "content": "The ops panel passes only workflowId, not dbProfile.",
      "metadata": { "severity": "medium" }
    }
  ],
  "payload": {
    "outputs": [
      { "type": "handoff", "summary": "Next, fix passing the recovery selector." }
    ]
  },
  "handoff": {
    "summary": "The recovery-path issue is located.",
    "next": ["Fix the selector", "Run admin-ui-smoke-test"]
  }
}
```

Rules:

- `doneSummary` lets a human read the state quickly.
- `taskOutputs` are consumed by downstream tasks, memory/context, and artifact routing.
- `payload.outputs` preserves the adapter's structured return.
- `handoff` records what the next stage / next agent must know.
- Large text, reports, and generated files go through a task-output artifact; don't keep them only in logs or chat.

### Block / Resume / Restart

| Situation | Correct action | Don't |
|-----------|----------------|-------|
| Missing input, missing permission, external service unavailable | `block-task` / runner returns `blocked` with `blockedReason` | Mark done and say "incomplete" in the summary |
| Continue after the user provides info | `resume-task` or `resume-assigned-work` | Create a duplicate workflow that masks the old blocked one |
| Intermediate task logic is wrong; rerun from that node | `restart-from-task` | Manually set downstream tasks back to pending |
| A chain stage needs rerunning | `restart-chain-from-stage` | Delete the stage outputs directly |
| A `doing` task is stuck or the lease expired | `release-expired-leases` / `sweep-task-timeouts` | Edit SQLite directly |

`block` is not a terminal failure — it's a recoverable breakpoint. `restart` preserves revision/rerun records, which suits real tasks that need auditing and replay.

### Real-project recipe

```js
const boundary = resolvePollutionBoundary({
  projectKey: 'gaokao-volunteer-system',
  dbProfile: 'gaokao-volunteer-system',
  workspacePath: '/workspace/gaokao-volunteer-system',
  sessionId: 'case-001',
  dataClass: 'real',
  retention: 'keep'
});
```

Usage requirements:

1. The workflow / runner / coordinator all use the same `boundary.db.dbPath`.
2. Plan metadata is set to `boundary.workflowHygieneMetadata`.
3. memory/context reuse `boundary.memory` and `boundary.context`.
4. Recovery commands carry `boundary.db.recoverySelector`.
5. Run artifacts are not auto-cleaned by default; audit with data hygiene before cleaning.

### Temporary-task recipe

```js
const boundary = resolvePollutionBoundary({
  projectKey: 'quick-smoke',
  workspacePath: '/workspace/workflow-closure',
  temporary: true
});
```

A temporary task is `test/ephemeral` by default: it can be hidden from default lists, its artifacts are cleanup candidates, and it suits smoke, debug, and experimental pipelines. Temporary tasks must not reuse a real project's `dbProfile`.

### Verification and final checks

A workflow wrap-up confirms at least three things:

1. `get-workflow-state` shows no unexpected `ready` / `doing` / `blocked`.
2. Key tasks have a `doneSummary`, `taskOutputs`, or `handoff`.
3. The data scope is correct: real tasks in an isolated `dbProfile`, temporary tasks as `test/ephemeral`.

If you changed the workflow engine, runner, output capture, context/memory, or pollution layers, select the minimal relevant smoke per "Minimal verification for the run layer" above — don't default to a full long run.

### Workflow anti-patterns

- Creating a workflow but never running `get-workflow-state` as a final check.
- An adapter that returns only natural language, no `taskOutputs` / `handoff`.
- Resuming in a new window with only `workflowId`, dropping `dbProfile` / `dbPath` / `workspacePath`.
- A real project and smoke tests sharing the same long-lived profile.
- Recreating a workflow after a failure, leaving the old one permanently blocked and unexplained.
- Editing DB state or deleting artifacts to "clean up" instead of using resume/restart/hygiene.

## Pollution Boundary Layers

workflow-closure splits pollution control into 5 layers. The machine-readable version lives in `runner/pollution-policy.js`, and the internal API exposes `listPollutionPolicyLayers()` via `workflow-closure/internal.js`.

| Layer | Boundary | Entry | Role |
|-------|----------|-------|------|
| L1 Source grading | context input | `runner/context-hygiene.js` | Tags task outputs, memory, and context items as `authoritative`, `validated`, `workflow-generated`, `reference`, `recovery-only`, or `quarantined`, setting the base trust level. |
| L2 Prompt filtering | prompt input | `runner/prompt-builder.js` | Only `promptAllowed` context enters the prompt; failed-validation evidence is by default given only to the repair task. |
| L3 Persistence sanitization | DB / memory / context / checkpoint | `runner/pollution-gateway.js` | Quarantines raw upstream diagnostics, 502s, `upstream_error`, stdout/stderr, and other transient dirty payloads before write. |
| L4 Output & file boundary | workspace files | `runner/task-capture.js`, `storage/workflows.js` | Writes structured results as task outputs / artifacts; paths must stay inside the workspace, recording `artifactRef` and `storageStatus` in metadata. |
| L5 Retention & cleanup | runtime data lifecycle | `storage/data-hygiene.js`, `scripts/data-hygiene.js`, `.gitignore` | Distinguishes `real/test/debug/unknown` and `keep/ephemeral/ttl`, hides test data by default, and audits/cleans run artifacts. |

Principle: L1–L3 govern "is the content trustworthy, may it enter the prompt/persistence", while L4–L5 govern "do files and data pollute the workspace". When adding a pollution rule, first decide which layer it belongs to — don't patch it at the call site.

### Unified boundary interface: `resolvePollutionBoundary()`

Standalone projects and temporary tasks should not hand-assemble `dbProfile`, `memory`, `context`, `dataClass`, and `retention`. Call `resolvePollutionBoundary()` first, then wire its return value into the workflow / runner / coordinator.

```js
import {
  createWorkflowEngine,
  createWorkflowRunner,
  resolvePollutionBoundary
} from 'workflow-closure';

const boundary = resolvePollutionBoundary({
  projectKey: 'gaokao-volunteer-system',
  dbProfile: 'gaokao-volunteer-system',
  workspacePath: '/workspace/gaokao-volunteer-system',
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
  instruction: 'Organize a real business task',
  plan: {
    goal: 'Organize a real business task',
    steps: [{ key: 'inspect', title: 'Inspect status', description: 'Review project materials.' }],
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

Key fields in the return structure:

| Field | Purpose | Wire into |
|-------|---------|-----------|
| `boundary.db.dbPath` | SQLite path already resolved by `dbProfile → dbPath → workspacePath → default` | `createWorkflowEngine()`, `createWorkflowRunner()`, coordinator runtime options |
| `boundary.db.recoverySelector` | Keeps the original data scope when recovering in a new window | ops panel recovery command, `resume-session` input |
| `boundary.memory` | memory scope / projectKey / workspacePath / sessionId | the `memory` option of runner / coordinator |
| `boundary.context` | context scope / projectKey / workspacePath / sessionId | the `context` option of runner / coordinator |
| `boundary.workflowHygieneMetadata` | `dataClass`, `retention`, boundary version, and projectKey | workflow plan metadata |
| `boundary.artifactPolicy` | Whether artifacts are cleanable; workspace file boundary | Artifact policy decisions; actual file writes still happen via task-output routing |
| `boundary.cleanupPolicy` | Which runtime targets are cleanup candidates | Basis for `scripts/data-hygiene.js` audit/cleanup |

### Wiring a standalone project

Real business, long-running projects, and recoverable tasks use an isolated profile:

```js
const boundary = resolvePollutionBoundary({
  projectKey: 'client-audit',
  dbProfile: 'client-audit',
  workspacePath: '/workspace/client-audit',
  sessionId: 'audit-2026-04-29',
  dataClass: 'real',
  retention: 'keep'
});
```

Effects:

- DB uses `isolated-db-profile`
- memory/context are confined to the same `projectKey + workspacePath + sessionId`
- workflow metadata is marked `real/keep`
- the recovery selector preferentially keeps `dbProfile`
- artifacts are not treated as auto-cleanable by default

### Wiring a temporary task

One-off smoke, triage, and experiment tasks use `temporary: true`:

```js
const boundary = resolvePollutionBoundary({
  projectKey: 'quick-smoke',
  workspacePath: '/workspace/workflow-closure',
  temporary: true
});
```

Defaults you get:

```js
boundary.workflowHygieneMetadata.dataClass === 'test'
boundary.workflowHygieneMetadata.retention === 'ephemeral'
boundary.artifactPolicy.cleanable === true
boundary.cleanupPolicy.autoCleanCandidates // ['artifacts', 'storage/test-workspaces']
```

A temporary task can still use the workspace DB, but it won't masquerade as real business data; the default workflow list hides test/debug/archived data, and run artifacts can be audited through data hygiene.

### Don't wire it like this

```js
// Don't: real business with no dbProfile — easily leaks into the default DB
createWorkflowEngine({ workspacePath: '/workspace/client-audit' });

// Don't: passing only dbPath without memory/context — later recall may mix across projects
createWorkflowRunner({ dbPath, workflowId, adapter });

// Don't: a temporary task forgetting dataClass/retention — default lists and cleanup can't judge it
createWorkflowFromInstruction({ instruction: 'debug smoke' });
```

The correct approach: call `resolvePollutionBoundary()` first, then reuse `boundary.db`, `boundary.memory`, `boundary.context`, and `boundary.workflowHygieneMetadata`.

### Automatic detection and boundaries

The current automation is "boundary interception", not a unified pollution event bus:

| Pollution / risk | Automatic handling |
|------------------|--------------------|
| upstream 502 / `upstream_error` / raw diagnostic payload | L3 auto-quarantines and writes a sanitized payload |
| `failed` / `tainted` / `superseded` task output entering the prompt | L1/L2 auto-block |
| failed-validation evidence reused by a normal task | L2 auto-blocks; only the repair task gets it |
| artifact path escaping the workspace | L4 auto-errors and blocks |
| artifact missing workspace/content | L4 marks `storageStatus=skipped` |
| test/debug workflow appearing in lists by default | L5 hides by default |
| runtime artifacts polluting Git status | L5 isolates via `.gitignore` and audits with `scripts/data-hygiene.js --runtime-artifacts` |

There is no unified `detectPollution()` / `recordPollutionIncident()` event interface yet. If you later need cross-layer pollution-event statistics, add an event-recording layer next to `runner/pollution-policy.js` rather than stuffing event logic into the prompt builder or storage.

## Error Reflection and Preventing Recurrence

Error reflection isn't writing "fixed" after the fact — it's distilling the error into a rule that makes the next investigation direct: **symptom → cause → fix → recurrence-prevention verification**.

### Record format

| Field | What to write clearly |
|-------|-----------------------|
| Symptom | What the user or test saw — e.g., a command error, wrong UI, recovery can't find data |
| Cause | The real wrong config ownership, data scope, state transition, or front/back boundary |
| Fix | Which config home, runner, CLI, frontend, or test you changed |
| Prevention | Which smoke test, syntax check, or doc rule you added or confirmed |

### Known pitfalls

| Pitfall | Typical symptom | Correct handling | Recurrence-prevention check |
|---------|-----------------|------------------|-----------------------------|
| An imported helper is re-declared locally | ESM error `Identifier has already been declared` | Delete the local duplicate; reuse the helper exported by the config home | `node --check cli.js` |
| Frontend hard-codes a local machine path | The ops panel recovery command only works on one machine | Backend runtime metadata provides `cliPath`; the frontend reads only `runtime.cliPath` | `admin-ui-smoke-test` asserts no repo-specific path |
| Browser directly imports a Node-only module | Frontend fails to load or no bundler exists | Keep a lightweight mirror for the bundler-less frontend and verify parity with the Node side via a smoke test | `node --check server/admin/app.js` + `admin-ui-smoke-test` |
| Recovery loses the data scope | A new window carries only `workflowId`, hits another DB or finds no workflow | The recovery selector must preserve `dbProfile` → explicit `dbPath` → `workspacePath` | `cli-smoke-test`, ops panel recovery assertions |
| API routes assembled separately on front and back | A button request 404s or the SSE path drifts | Change `server/admin-api-routes.js` on the Node side; mirror in `server/admin/api-routes.js` | `admin-ui-smoke-test` |
| Port/URL hard-coded everywhere | The default address or `HOST` / `PORT` override stops working | Change only `server/admin-server-config.js`; consumers call the resolver/builder | syntax check + manual ops panel check |
| Inserting a new README section breaks a heading | A CLI table loses its parent section; readers can't find the entry later | After inserting, read the neighboring sections and confirm the heading hierarchy is intact | Read the relevant README range |

### Handling principles

1. First classify the error into one of the four config homes or a workflow run-layer entry; avoid patching at the call site.
2. Each fix adds at least one verification: a syntax check, a smoke test, or a README rule.
3. For data-recovery issues, first check whether the runtime selector was preserved; don't suspect the `workflowId` first.
4. For frontend issues, first distinguish browser static files, API route, backend payload, or server config.
5. Don't edit SQLite state to mask an error; use the existing resume/restart/release/sweep commands to leave a traceable record.

## CLI Commands

### Workflow

| Command | Purpose | Key input |
|---------|---------|-----------|
| `draft-plan` | Generate an execution plan from an instruction | `instruction` |
| `create-workflow` | Create a workflow | `instruction`, `plan` |
| `create-workflow-definition` | Save a reusable workflow definition | `name`, `instruction`, `plan` |
| `get-workflow-definition` | Query one workflow definition | `definitionId` |
| `list-workflow-definitions` | List workflow definitions | `search`, `sourceWorkflowId`, `limit` |
| `create-workflow-from-definition` | Create a workflow instance from a definition | `definitionId` |
| `draft-coding-plan` | Generate a coding-workflow plan from a coding instruction | `instruction`, `changedFiles`, `packageScripts` |
| `create-coding-workflow` | Create a workflow with coding steps and verification requirements | `instruction`, `changedFiles`, `plan` |
| `select-validation` | Select verification commands from explicit changed files (does not run them) | `changedFiles`, `packageScripts`, `profile` |
| `get-workflow-state` | Query workflow state | `workflowId` |
| `list-workflow-reruns` | Query workflow rerun records | `workflowId` |
| `list-task-revisions` | Query task revision history | `workflowId`, `taskId` |
| `list-descendant-task-ids` | Query downstream tasks | `workflowId`, `taskId` |
| `restart-from-task` | Rerun from a given task | `workflowId`, `taskId`, `reason` |
| `claim-next-ready-task` | Claim a ready task | `leaseOwner`, `leaseMs` |
| `heartbeat-task-lease` | Renew a task lease | `workflowId`, `taskId`, `leaseOwner` |
| `complete-task` | Complete a task | `workflowId`, `taskId`, `doneSummary` |
| `block-task` | Block a task | `workflowId`, `taskId`, `blockedReason` |
| `resume-task` | Resume a blocked task | `workflowId`, `taskId` |
| `release-expired-leases` | Release expired leases | `reason` |
| `sweep-task-timeouts` | Scan and reclaim/block timed-out doing tasks | `workflowId`, `maxExecutionMs`, `stalledMs`, `maxAttempts`, `reason` |

### Chain (multi-stage workflow)

| Command | Purpose |
|---------|---------|
| `create-chain` | Create a stage chain |
| `get-chain-state` | Query stage-chain state |
| `run-chain` | Execute the whole chain |
| `run-next-stage` | Execute the next stage |
| `resume-chain-stage` | Resume a blocked stage |
| `restart-chain-from-stage` | Rerun from a given stage |

### Coordinator (multi-agent collaboration)

| Command | Purpose |
|---------|---------|
| `register-agent` | Register an agent |
| `get-coordinator-state` | Query coordinator state |
| `assign-next-work` | Assign work to an agent |
| `run-next-assignment` | Execute an assignment |
| `resume-assigned-work` | Resume a blocked assignment |

### Runner

| Command | Purpose |
|---------|---------|
| `run-next-task` | The runner automatically claims and advances the next task |

Besides `workflowId`, `runnerId`, `leaseMs`, and `maxTaskRetries`, `run-next-task` also supports these timeout runtime parameters:

- `taskExecutionTimeoutMs`: per-execution adapter timeout threshold; exceeding it treats the current execution as a runner timeout.
- `timeoutSweepMaxExecutionMs`: treats a `doing` task whose execution time exceeds the threshold as timed out.
- `timeoutSweepStalledMs`: treats a long-idle `doing` task as stalled.
- `timeoutSweepMaxAttempts`: how many times a timed-out task is auto-reclaimed; after exhaustion it becomes `blocked`.
- `timeoutSweepIntervalMs`: the minimum interval for the runner's auto-sweep, to throttle multi-round loops.
- `timeoutSweepReason`: the reason text the auto-sweep writes to the task/log.

If a task `contract` explicitly declares `executionTimeoutMs`, `stalledTimeoutMs`, `maxTimeoutAttempts`, or `timeoutReason`, those task-level policies take precedence over the runner runtime defaults; the runner's timeout parameters serve only as fallbacks when no task policy is declared.

Once `timeoutSweepMaxExecutionMs` or `timeoutSweepStalledMs` is configured, every `run-next-task` / `runOnce()` first runs automatic maintenance:

1. Run the timeout sweep, throttled by `timeoutSweepIntervalMs`
2. Auto-release expired leases
3. Then claim the next ready task

So timeout management is now an automatic closed loop: timed-out or stalled `doing` tasks return to `ready` without external manual maintenance, or become `blocked` after reaching `timeoutSweepMaxAttempts`.

The `sweep-task-timeouts` command remains for one-off ops sweeps, manual remediation, or offline maintenance; it reuses the same underlying state-transition logic as the runner's automatic maintenance.

## Input Methods

The CLI supports four structured input methods:

- `--input '<json>'`
- `--input-file ./input.json`
- `--input-stdin`
- `--input-file -` (read stdin as the input file)

Recommended priority:

1. `--input-file ./input.json`: most robust, good for complex JSON
2. `--input-stdin`: good for pipes or PowerShell/CI
3. `--input-file -`: good when you want file semantics but feed content via stdin
4. `--input '<json>'`: only for simple, short inline JSON

Besides passing `instruction` / `plan` directly, `create-workflow` also supports input via a task source:

- `taskSourceFile` / `taskSourcePath`
  - `.json`: actually imported into the workflow as a structured task source
  - `.doc` / `.docx` / `.pdf` / `.ppt` / `.pptx`: currently placeholder compatibility only — it means the file can plug into the workflow main path, not that its body has been accurately parsed
- `taskSourceModule`: load a custom JS task-source module

## Quick Examples

```bash
npm install

# Create a workflow
node cli.js create-workflow --input '{"instruction":"Implement login"}'

# Create a workflow from a JSON task source
node cli.js create-workflow --input '{"taskSourceFile":"./workflow.json"}'

# Create a placeholder workflow from a document file
node cli.js create-workflow --input '{"taskSourceFile":"./brief.pdf","instruction":"Review the PDF and organize tasks"}'

# Create a workflow via stdin
printf '%s' '{"instruction":"Create a workflow via stdin"}' | node cli.js create-workflow --input-stdin

# Create a workflow via --input-file - from stdin
printf '%s' '{"instruction":"Create a workflow via the stdin file alias"}' | node cli.js create-workflow --input-file -

# Claim the next ready task
node cli.js claim-next-ready-task --input '{"leaseOwner":"agent-1","leaseMs":60000}'

# Complete a task (needs workflowId and taskId)
node cli.js complete-task --input '{"workflowId":"<workflow-id>","taskId":"<task-id>","doneSummary":"Done"}'
```

## Workflow Definitions

A workflow definition is a reusable workflow template. It is separate from a workflow instance:

- A definition persists `instruction`, `goal`, `plan`, and `metadata`.
- An instance is derived from a definition each time, with its own `workflowId`, task states, and run log.
- It suits running the same kind of task repeatedly, rather than calling `create-workflow` from scratch each time.

```bash
# Save a reusable definition
node cli.js create-workflow-definition --input-file ./definition.json

# Query a definition
node cli.js get-workflow-definition --input '{"definitionId":"release-checklist"}'

# Search / list definitions
node cli.js list-workflow-definitions --input '{"search":"release","limit":10}'

# Create a workflow instance from a definition
node cli.js create-workflow-from-definition --input '{"definitionId":"release-checklist","workflowId":"release-checklist-001"}'
```

Common `create-workflow-definition` fields:

- `definitionId`: optional; auto-generated if omitted
- `name`: required; definition name
- `description`: optional; human-readable note
- `instruction` / `goal` / `plan`: the definition body
- `metadata`: optional; extra structured metadata
- `sourceWorkflowId`: optional; records which workflow this definition came from

A coding workflow is a preprocessing layer for coding tasks on top of the generic workflow: it does not change code directly but breaks the coding instruction into four steps — inspect, implement, select-validation, run-validation — and writes the verification requirements into the task contract.

```bash
# Only generate a coding plan
node cli.js draft-coding-plan --input '{"instruction":"Fix verifier selection logic","changedFiles":["runner/verifier.js"],"packageScripts":{"verifier-smoke-test":"node ./scripts/verifier-smoke-test.js","runner-smoke-test":"node ./scripts/runner-smoke-test.js"}}'

# Generate and create a coding workflow
node cli.js create-coding-workflow --input '{"workflowId":"coding-fix","instruction":"Fix the CLI coding workflow","changedFiles":["cli.js"]}'

# Only select verification commands, don't run
node cli.js select-validation --input '{"changedFiles":["runner/verifier.js"],"profile":"standard"}'
```

Verification commands are saved as structured objects in `task.contract.validationCommands`, e.g. `command`, `args`, `script`, `cwd`, `required`, `timeoutMs`, `reason`. The prompt builder renders these commands into the task prompt; after running verification the executor should write evidence to `payload.validationResults`, and if a required verification cannot run it should return `blocked`.

### Workflow closure policy

A coding workflow fixes the workflow-level closure policy into `workflow.initialPlan.metadata` as the single source of truth in v1:

- `closureMode=small_loop`
- `verificationLevel=targeted`
- `docPolicy=minimal`
- `cleanupPolicy=defer`

The planner writes these defaults first and only conservatively upgrades to a larger closure policy when a clear cross-boundary signal appears. The wrapper / runner reads this metadata uniformly at run time; the prompt builder renders it into agent execution constraints; the verifier consumes the verification scope per `verificationLevel` and writes a policy snapshot into the verification evidence and runner output metadata.

First-version boundary:

- `workflow.initialPlan.metadata` is the only policy source
- Only static policy landing; no mid-run dynamic upgrade
- No new database schema; continue reusing `initial_plan_json`

## Result-Driven Workflow

- For outputs like `runner-result` that have **no explicit `path`**, as long as they have writable `content` and a usable `workspacePath`, a path `artifacts/workflows/<workflowId>/<taskId>/results/...` is generated automatically — written to SQLite and persisted to the workspace at the same time.
- If `workspacePath`, `content`, or a valid target path is missing, such outputs still keep a database record but are marked `storageStatus=skipped` and not actually persisted.
- After successful persistence, the output metadata adds `artifactRef`, `storageStatus`, `relativePath`, `workspacePath`, etc., forming a closed loop of "database record + physical artifact reference".
- `output.path` means the **artifact target path**; `condition.path` still means a **JSON selector on the output object** — different semantics.

```js
{
  kind: 'result',
  name: 'runner-result',
  contentText: '<doneSummary or message>',
  metadata: {
    routingSignal: payload.routingSignal,
    handoffSummary: '<handoff.summary>',
    verificationSummary: { status, reason, reasonCode },
    checkpointSummary: { status, summary, artifactRef }
  }
}
```

An adapter can also write more outputs explicitly via `payload.outputs[]`:

```js
return {
  status: 'done',
  doneSummary: 'Completed and selected the reviewer branch',
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

A plan dependency can carry a `condition`. A successor task moves from `pending` to `ready` only when all predecessors are done and the condition is true:

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

The first version supports `exists`, `equals`, `notEquals`, and `includes`. A successor with a false condition is automatically marked `skipped` and records the `dependency_condition_not_met` reasonCode. This layer adds only the minimal closed loop of "result storage + conditional dependency"; chain branching, dynamic role routing, and a retry-strategy engine are later capabilities.

Minimal return structure:

```js
export default async function adapter(input) {
  return {
    status: 'done', // or 'blocked'
    doneSummary: 'Completion note',
    blockedReason: null,
    payload: {},
    handoff: {
      summary: 'Handoff summary',
      artifacts: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      recommendedNextRole: null
    }
  };
}
```

Single-runner usage:

```bash
node cli.js run-next-task --adapter-module ./examples/adapters/simple-js-adapter.js --input '{"workflowId":"<workflow-id>","runnerId":"agent-1"}'
```

Runner with automatic timeout maintenance:

```bash
node cli.js run-next-task --adapter-module ./examples/adapters/simple-js-adapter.js --input '{"workflowId":"<workflow-id>","runnerId":"agent-1","taskExecutionTimeoutMs":300000,"timeoutSweepMaxExecutionMs":300000,"timeoutSweepMaxAttempts":2,"timeoutSweepIntervalMs":5000}'
```

Multi-agent usage:

```bash
node cli.js register-agent --input '{"agentId":"agent-1","name":"Agent 1","role":"implementer","capabilities":["implement"],"adapterModule":"./examples/adapters/simple-js-adapter.js"}'
node cli.js assign-next-work --input '{"workflowId":"<workflow-id>"}'
node cli.js run-next-assignment --input '{"workflowId":"<workflow-id>"}'
```

If you want an agent to know its visible tools, memory boundary, and workspace constraints by default during execution, pass `visibility` to `register-agent`. It is an **execution hint**, not a routing gate; what actually decides whether an agent can take a task is still `role` / `requiredRole` and `capabilities` / `requiredCapabilities`.

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
        "purpose":"Modify the implementation inside the current workspace",
        "whenToUse":"Use when executing implement tasks",
        "constraints":"Only modify the current workflow workspace"
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

The runner / coordinator passes these execution hints through to:

- the `Execution context` section in the prompt
- `executionContext` in the adapter input
- `activeMemoryContext` in the adapter input
- `execution-tools` / `execution-memory` / `execution-workspace` in the context bundle

So even when the current recall result is empty, the agent still knows by default where to read/write memory, which default tools it has, and what the workspace boundary is.

A Claude Code adapter can reuse the existing subprocess adapter via `createClaudeCodeAdapter()`:

```js
import { createClaudeCodeAdapter } from 'workflow-closure';

export default createClaudeCodeAdapter({
  command: 'claude',
  args: ['--print'],
  timeoutMs: 120_000
});
```

Built-in AI provider adapters are also available, suited for connecting directly to an HTTP API without first wrapping a subprocess:

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

Both provider adapters follow the same `done | blocked` result contract as other adapters: the provider's returned text content must be a JSON adapter result; the runtime automatically makes the HTTP request, extracts the text, validates the contract, and writes provider / endpoint / model / HTTP-status metadata back into the adapter payload for later debugging.

Reference examples: `examples/adapters/simple-js-adapter.js` and `examples/adapters/claude-code-adapter-module.js`.

## Machine-Readable Docs

AI agents discover commands automatically through these files:

- `agent-integration-contract.json` — the command list and parameter definitions
- `cli-protocol-examples.json` — input/output examples for each command

## Data Scope

workflow-closure names default data and isolated data separately:

- Default workspace data: when `dbProfile` / `dbPath` are not passed, it resolves by the current `workspacePath` to `storage/workspaces/<workspace-key>/workflow-closure.db`.
- Default global data: only used when there is no workspace — `storage/workflow-closure.db`.
- Isolated profile data: when `dbProfile` or `profile` is passed, it uses `storage/workspaces/profiles/<profile>/workflow-closure.db`, suited for real business, long-running projects, or tasks needing isolation.
- Explicit database: when `dbPath` is passed, it uses that database file directly, suited for temporary migration or external hosting.

The CLI / ops panel exposes `dbPathSource` and `dbScopeLabel` to distinguish `default-workspace-db`, `default-global-db`, `isolated-db-profile`, and `explicit-db-path`. These labels and the recovery selection logic live together in `storage/db-scope-config.js`.

## Framework Config Partitions

Framework config is archived under four entry points. Any later change must first decide which category it belongs to, then change the corresponding file, to avoid further scattering:

| Category | Entry file | Manages | Does not manage |
|----------|------------|---------|-----------------|
| Service listen config | `server/admin-server-config.js` | admin front/back default host, port, URL; `HOST` / `PORT` env vars; service listen params | No concrete API routes, no Claude runtime params |
| API route config | `server/admin-api-routes.js`, `server/admin/api-routes.js` | `/api/...` path constants, prefix/suffix, URL builder | No ports, no business logic |
| Runtime execution config | `runtime/claude-runtime-config.js` | Claude/agent/adapter/workspace/timeout/retry defaults; `WORKFLOW_CLOSURE_CLAUDE_*` env vars; default Claude command/args parsing | No workflow DB scope text, no admin API routes |
| Data scope config | `storage/db-scope-config.js`, `server/admin/db-scope-config.js` | Labels for default workspace/global DB and isolated profile/explicit DB; profile list; recovery selector. The browser mirror holds only the same-named labels and helpers needed for frontend display/recovery selection | Does not open SQLite directly, does not decide the server port |

### Rules for later changes

1. Changing the admin port, host, or ops panel URL: change only `server/admin-server-config.js`; consumers read via `resolveAdminServerListenOptions()` / `buildAdminServerUrl()`.
2. Adding or renaming a backend API: change `server/admin-api-routes.js` first, then sync `server/admin/api-routes.js`. The frontend has no bundler and cannot import Node-side files directly.
3. Changing the Claude runtime default command, args, agent identity, timeout, retry, or `WORKFLOW_CLOSURE_CLAUDE_*`: change only `runtime/claude-runtime-config.js`; `scripts/claude-runtime-profile.js` only parses it into profile output.
4. Changing default/isolated data naming, `dbPathSource`, `dbScopeLabel`, the profile list, or the recovery-command selector: change `storage/db-scope-config.js` first; if it affects the ops panel display, then sync the browser mirror `server/admin/db-scope-config.js`. `storage/db.js` only resolves DB paths and opens the DB.
5. The ops panel recovery command must not hard-code a local machine path; backend runtime metadata provides `cliPath`, and the frontend generates the command from `runtime.cliPath`.
6. When adding config, don't drop it at the call site. First decide which of the four categories it belongs to; if it fits none, explain why a new config surface is needed.

### Minimal verification after changes

When these configs are involved, run at least:

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

Expected boundary: the default ops address is still `http://127.0.0.1:3001`; `HOST` / `PORT` still affect only the admin server; `WORKFLOW_CLOSURE_CLAUDE_*` still affects only the Claude runtime profile; the recovery command preserves the data scope by `dbProfile` → explicit `dbPath` → `workspacePath`.

## Concurrency Control

When multiple agents write at once, a file lock serializes them:

```js
// storage/db.js
withDbLock(dbPath, () => {
  // write operation
});
```

## Ops Panel

The local ops panel is for directly observing and operating coordinator state, covering Agents, Assignments, Handoffs, blocked work, and Resume / Reassign.

```bash
npm run ops-panel
```

Default address: `http://127.0.0.1:3001`

Currently supported operations:

- Refresh coordinator state
- Assign next
- Run next
- Resume blocked assignment
- Reassign blocked assignment
- View the detailed state of a given chain

Note: the panel is a local ops entry point only; it provides no authentication, multi-tenant isolation, or production-console capabilities.

## Testing

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
npm run full-smoke-test  # full smoke + stress regression
npm run generate-cli-protocol-examples
npm run generate-agent-integration-contract
npm run verify-agent-contract
```

## Platform Notes

- The CLI runs via Node.js with uniform cross-platform usage: `node cli.js <command>` or, after install, `workflow-closure <command>`.
- On Windows / PowerShell, prefer not to use `--input '{...}'` for complex JSON; `--input-file ./input.json`, `--input-stdin`, or `--input-file -` are more robust.
- `--input-stdin` and `--input-file -` suit PowerShell, CI, and cross-shell pipelines, avoiding inline-JSON quoting and `&` parsing issues.
- The subprocess execution method is determined by the adapter's configured `command` / `args` / `cwd` / `env`, not by the CLI auto-switching shells.

## Dependencies

- `better-sqlite3`

## License

[MIT](./LICENSE)
