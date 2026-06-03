# workflow-closure 长期运行 Claude runtime 用法

本文说明如何在 `workflow-closure` 中让 Claude Code 作为长期运行的 runtime agent，持续领取、执行、恢复 workflow assignment，并通过本地 ops 面板观察状态。

## 适用场景

适合需要把较长任务拆成 workflow，并让 Claude Code 按任务队列逐步推进的场景，例如：

- 持续执行 workflow 中的 ready task。
- 由 coordinator 分配 assignment 给 Claude agent。
- 任务失败、阻塞、超时后，通过 resume / retry 继续推进。
- 通过本地 DB、run logs、task outputs 定位执行结果和故障。

本文聚焦最小可交付闭环，不覆盖完整生产多租户控制台或远程鉴权部署。

## 1. 准备环境

在项目根目录安装依赖：

```bash
npm install
```

Claude runtime 默认会复用本机 Claude Code CLI。当前 runtime profile 会优先寻找已安装的 Claude Code JS 入口；找不到时退回 `claude --print`。

关键默认值位于 `scripts/claude-runtime-profile.js`：

- 默认 agentId：`claude-code`
- 默认 workspace：项目根目录
- 默认 adapter：`scripts/claude-runtime-adapter-module.js`
- 默认 Claude subprocess timeout：`600000ms`
- 默认 task execution timeout：`630000ms`
- 默认 ops host/port：`127.0.0.1:3001`

## 2. 注册 Claude agent

先确保 Claude agent 写入 coordinator：

```bash
npm run claude-runtime-ensure-agent
```

该脚本会使用 runtime profile 注册一个 agent，默认具备：

- role：`implementation`
- capabilities：`claude-code`, `workflow-closure`
- adapterModule：`scripts/claude-runtime-adapter-module.js`

如果需要覆盖 workspace、DB、timeout 或 agent 信息，可通过环境变量配置，例如：

```bash
WORKFLOW_CLOSURE_CLAUDE_WORKSPACE_PATH="/workspace/workflow-closure" \
WORKFLOW_CLOSURE_CLAUDE_TIMEOUT_MS=600000 \
npm run claude-runtime-ensure-agent
```

## 3. 启动 ops 面板

本地运维面板用于观察 agents、assignments、handoffs、blocked work，并触发 assign / run / resume / reassign 操作：

```bash
npm run claude-runtime-ops
```

或使用通用 ops panel：

```bash
npm run ops-panel
```

默认地址：

```text
http://127.0.0.1:3001
```

注意：当前面板是本地运维入口，不提供鉴权、多租户隔离或生产控制台能力。

## 4. 创建或选择 workflow

可以用 CLI 创建 workflow：

```bash
node cli.js create-workflow --input '{"instruction":"撰写一份关于 workflow-closure 长期运行 Claude runtime 用法的中文文档"}'
```

也可以直接使用已有 workflowId。后续命令都需要知道目标 workflowId。

## 5. 分配并执行 assignment

长期运行 Claude runtime 的推荐入口是：

```bash
npm run claude-runtime-run-assignment -- --workflow-id "<workflow-id>"
```

它会按当前 runtime profile：

1. 确保 agent 可用。
2. 让 coordinator 查找当前 workflow 的可分配 ready work。
3. 将 task assignment 交给 Claude Code adapter。
4. 把执行结果、handoff、task outputs、run logs 写回 workflow DB。

可按需限制重试和超时：

```bash
npm run claude-runtime-run-assignment -- \
  --workflow-id "<workflow-id>" \
  --max-task-retries 20 \
  --task-execution-timeout-ms 120000
```

`--task-execution-timeout-ms` 是 workflow runner 层的任务执行超时；Claude subprocess 本身还受 runtime profile 中 `WORKFLOW_CLOSURE_CLAUDE_TIMEOUT_MS` 或默认 timeout 控制。

## 6. 恢复阻塞任务

当 workflow 中存在 blocked task 时，可执行 resume：

```bash
npm run claude-runtime-run-assignment -- \
  --workflow-id "<workflow-id>" \
  --resume \
  --message "继续处理当前阻塞任务"
```

如果需要恢复明确的 task，传入 taskId：

```bash
npm run claude-runtime-run-assignment -- \
  --workflow-id "<workflow-id>" \
  --task-id "<task-id>" \
  --resume \
  --message "恢复指定任务"
```

实践注意：

- workflow 级 resume 应恢复当前真实阻塞点，而不是历史 stale blocked task。
- 如果 task 已是 `ready`，普通 run 会重新领取；如果 task 是 `blocked`，使用 resume。
- 如果已有 assignment 处于 `accepted`，直接按 workflowId 执行不一定会复用旧 assignment；需要以当前 coordinator 状态为准。

## 7. 查看状态和结果

查看 workflow 状态：

```bash
node cli.js get-workflow-state --input '{"workflowId":"<workflow-id>"}'
```

查看 task outputs：

```bash
node cli.js list-task-outputs --input '{"workflowId":"<workflow-id>","taskId":"<task-id>"}'
```

常见结果位置：

```text
artifacts/workflows/<workflow-id>/<task-id>/results/
```

每次 runner 写入 result output 时，会记录相对 path、metadata、handoff summary 和 trustState。最终文档类任务应把可交付内容放入 task outputs 或 payload.outputs，并在 handoff.artifacts 中列出建议路径。

## 8. 超时与 lease 维护

runner 执行时会涉及两类超时：

1. Claude subprocess timeout：Claude CLI/API 调用自身超时。
2. task execution timeout：workflow runner 等待任务执行结果的超时。

如果任务执行超时，runner 会按策略把任务释放回 ready 或阻塞为 blocked，并写入 run log，例如：

- `task_timeout_released`
- `task_timeout_by_runner`
- `task_lease_released`

可手动释放过期 lease：

```bash
node cli.js release-expired-leases --input '{"workflowId":"<workflow-id>","reason":"Release expired task lease."}'
```

也可触发 timeout sweep：

```bash
node cli.js sweep-task-timeouts --input '{"workflowId":"<workflow-id>","taskExecutionTimeoutMs":300000}'
```

维护后应重点检查：

- task status 是否回到 `ready` 或明确 `blocked`。
- `assignmentStatus` 是否仍错误停留在 `assigned` / `accepted`。
- `ownerAgentId`、`leaseOwner`、`leaseExpiresAt` 是否已清理。

## 9. 常见故障排查

### 9.1 没有 ready work

现象：runner 返回 `idle` / `no_ready_work`。

检查：

```bash
node cli.js get-workflow-state --input '{"workflowId":"<workflow-id>"}'
```

重点看：

- workflow.currentTaskId 是否为空。
- 当前 task 是否为 `ready`。
- assignmentStatus 是否为可分配状态，例如 `unassigned` 或 `released`。
- 是否存在历史 blocked task 污染了 resume 目标。

### 9.2 Claude subprocess 502

502/upstream_error 来自 Claude 上游服务，不是 workflow-closure 本地生成。无法在本地完全消除，但可以降低触发概率和污染范围：

- 缩短 prompt，避免把完整 transient error JSON 继续塞回后续 prompt。
- 对 `lastError`、handoff、memory/context 中的 502 内容做摘要化。
- 使用较短 task timeout 快速失败，再通过 resume/retry 继续。
- 不把一次 502 当作业务任务失败结论。

### 9.3 任务长时间 doing

如果 task 长时间停留在 `doing`，检查 lease：

- `leaseOwner`
- `leaseExpiresAt`
- `startedAt`
- `attemptCount`

过期后可用 `release-expired-leases` 或 `sweep-task-timeouts` 收敛。

### 9.4 blocked 后如何继续

如果 task 因超时或错误进入 blocked：

```bash
npm run claude-runtime-run-assignment -- \
  --workflow-id "<workflow-id>" \
  --resume \
  --message "根据上次错误继续，避免重复完整错误正文"
```

如果是最终文档输出类任务，优先利用已有 predecessor outputs / handoff 直接收敛最终交付，避免反复启动长 subprocess。

## 10. 最小闭环建议

一次长期运行 Claude runtime 的最小闭环如下：

1. `npm install`
2. `npm run claude-runtime-ensure-agent`
3. `npm run claude-runtime-ops`
4. 创建或选定 workflow。
5. `npm run claude-runtime-run-assignment -- --workflow-id "<workflow-id>"`
6. 用 `get-workflow-state` 和 `list-task-outputs` 检查结果。
7. blocked 时用 `--resume` 恢复。
8. timeout / lease 异常时先 release/sweep，再重新 run 或 resume。

建议保存路径：

```text
docs/claude-runtime-long-running-zh.md
```
