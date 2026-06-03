import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentWorkflowChain,
  createAgentMemorySystem,
  createWorkflowEngine
} from '../index.js';
import { createAdminServer } from '../server/admin-server.js';
import { ADMIN_SERVER_DEFAULT_HOST } from '../server/admin-server-config.js';
import { buildAdminApiPath, ADMIN_API_PATHS } from '../server/admin-api-routes.js';
import { AdminApiRoutes } from '../server/admin/api-routes.js';
import { createWorkflowTaskSourceRef } from '../internal.js';
import { closeDb } from '../storage/db.js';
import { markTestPlan, prepareTestDb } from './helpers/test-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const dbPath = await prepareTestDb('admin-ui-smoke-test');

async function main() {
  await fs.rm(path.join(rootDir, 'scripts', '.tmp', 'admin-ui'), { recursive: true, force: true });

  let adminServer = null;

  try {
    adminServer = await createAdminServer({
      dbPath,
      workspacePath: rootDir
    });

    const blockedWorkflows = new Set();

    const researcher = adminServer.coordinator.registerAgent({
      agentId: 'admin-ui-researcher',
      name: 'Admin UI Researcher',
      role: 'researcher',
      capabilities: ['research', 'handoff'],
      status: 'active',
      adapter: async ({ task }) => ({
        status: 'done',
        doneSummary: `调研完成：${task.title}`,
        handoff: {
          summary: '已完成调研，可交给实现角色。',
          artifacts: ['ops-panel-research.md'],
          decisions: ['继续进入实现阶段'],
          openQuestions: [],
          risks: [],
          recommendedNextRole: 'implementer'
        }
      })
    });

    const primaryImplementer = adminServer.coordinator.registerAgent({
      agentId: 'admin-ui-implementer-primary',
      name: 'Admin UI Implementer Primary',
      role: 'implementer',
      capabilities: ['implement', 'handoff'],
      status: 'active',
      adapter: async ({ workflow, task }) => {
        const workflowKey = workflow?.instruction || task?.title || 'unknown';
        if (!blockedWorkflows.has(workflowKey)) {
          blockedWorkflows.add(workflowKey);
          return {
            status: 'blocked',
            blockedReason: `等待恢复：${task.title}`,
            payload: {
              phase: 'implement-blocked'
            }
          };
        }

        return {
          status: 'done',
          doneSummary: `实现完成：${task.title}`,
          taskOutputs: [
            {
              kind: 'artifact',
              name: 'implementation-summary',
              content: `实现产物：${task.title}`,
              path: 'scripts/.tmp/admin-ui/implementation-summary.txt',
              metadata: {
                role: 'implementer',
                taskTitle: task.title
              }
            }
          ],
          handoff: {
            summary: '实现已完成，可交给 verifier。',
            artifacts: ['ops-panel.patch'],
            decisions: ['保留阻塞恢复历史'],
            openQuestions: [],
            risks: ['需要 verifier 做最终确认'],
            recommendedNextRole: 'verifier'
          }
        };
      }
    });

    let backupImplementer = null;
    const verifier = adminServer.coordinator.registerAgent({
      agentId: 'admin-ui-verifier',
      name: 'Admin UI Verifier',
      role: 'verifier',
      capabilities: ['verify'],
      status: 'active',
      adapter: async ({ task }) => ({
        status: 'done',
        doneSummary: `验证完成：${task.title}`,
        taskOutputs: [
          {
            kind: 'validation-result',
            name: 'verification-report',
            content: `验证通过：${task.title}`,
            metadata: {
              role: 'verifier',
              taskTitle: task.title,
              passed: true
            }
          }
        ],
        payload: {
          phase: 'verify'
        }
      })
    });

    assert(researcher.agentId && primaryImplementer.agentId && verifier.agentId, 'smoke test should register the initial fixture agents');

    const chain = await createAgentWorkflowChain({
      dbPath,
      workflowHygieneMetadata: {
        dataClass: 'test',
        retention: 'ephemeral',
        generatedBy: 'admin-ui-smoke-test'
      },
      adapter: async ({ task }) => ({
        status: 'done',
        doneSummary: `fixture run completed: ${task?.title || 'unknown task'}`,
        taskOutputs: [
          {
            kind: 'artifact',
            name: 'fixture-output',
            content: `fixture output: ${task?.title || 'unknown task'}`
          }
        ]
      })
    });
    const resumeFixture = chain.createChain({
      instruction: 'admin-ui resume flow',
      stages: [
        {
          title: '调研 resume 场景',
          instruction: '先完成调研并交接给 implementer',
          preferredRole: 'researcher',
          requiredCapabilities: ['research']
        },
        {
          title: '实现 resume 场景',
          instruction: '实现阶段先阻塞，再通过 resume 恢复',
          preferredRole: 'implementer',
          requiredCapabilities: ['implement']
        },
        {
          title: '验证 resume 结果',
          instruction: '验证 resume 后的实现结果',
          preferredRole: 'verifier',
          requiredCapabilities: ['verify']
        }
      ]
    });

    const reassignFixture = chain.createChain({
      instruction: 'admin-ui reassign flow',
      stages: [
        {
          title: '调研 reassign 场景',
          instruction: '先完成调研并交接给 implementer',
          preferredRole: 'researcher',
          requiredCapabilities: ['research']
        },
        {
          title: '实现 reassign 场景',
          instruction: '实现阶段先阻塞，再重新分配给 backup implementer',
          preferredRole: 'implementer',
          requiredCapabilities: ['implement']
        },
        {
          title: '验证 reassign 结果',
          instruction: '验证重新分配后的实现结果',
          preferredRole: 'verifier',
          requiredCapabilities: ['verify']
        }
      ]
    });

    const rerunFixture = chain.createChain({
      instruction: 'admin-ui rerun observability flow',
      stages: [
        {
          title: '第一阶段',
          instruction: '先完成第一阶段'
        },
        {
          title: '第二阶段',
          instruction: '第二阶段需要在纠正上游错误后重新产出结果',
          plan: markTestPlan({
            goal: '第二阶段需要在纠正上游错误后重新产出结果',
            steps: [
              {
                key: 'collect-facts',
                title: '收集可信事实',
                description: '先产出上游可信事实'
              },
              {
                key: 'rewrite-conclusion',
                title: '改写错误结论',
                description: '修正语义上错误的中间结论'
              },
              {
                key: 'publish-result',
                title: '重新输出结果',
                description: '基于修正后的结论重新产出最终结果'
              }
            ],
            dependencies: [
              { from: 'collect-facts', to: 'rewrite-conclusion' },
              { from: 'rewrite-conclusion', to: 'publish-result' }
            ]
          }, 'admin-ui-smoke-test')
        }
      ]
    });

    const workflowEngine = await createWorkflowEngine({ dbPath });
    const monitorFixture = workflowEngine.createWorkflowFromInstruction({
      workflowId: 'admin-ui-monitor-flow',
      instruction: 'admin-ui monitor flow',
      concurrencyLimit: 2,
      plan: markTestPlan({
        goal: 'admin-ui monitor flow',
        steps: [
          {
            key: 'planner-window',
            title: '监控 planner 窗口',
            description: 'planner active window should appear in the admin monitor.',
            status: 'ready',
            preferredRole: 'planner'
          },
          {
            key: 'reviewer-window',
            title: '监控 reviewer 窗口',
            description: 'reviewer active window should appear in the admin monitor.',
            status: 'ready',
            preferredRole: 'reviewer'
          }
        ],
        dependencies: []
      }, 'admin-ui-smoke-test')
    });
    const monitorWorkflowId = monitorFixture.workflow.workflowId;
    const plannerClaim = workflowEngine.claimNextReadyTask({
      workflowId: monitorWorkflowId,
      leaseOwner: 'planner-agent',
      preferredRole: 'planner',
      leaseMs: 600000
    });
    const reviewerClaim = workflowEngine.claimNextReadyTask({
      workflowId: monitorWorkflowId,
      leaseOwner: 'reviewer-agent',
      preferredRole: 'reviewer',
      leaseMs: 600000
    });
    workflowEngine.addTaskOutput({
      workflowId: monitorWorkflowId,
      taskId: plannerClaim.task.taskId,
      kind: 'handoff',
      name: 'monitor-handoff',
      content: 'monitor handoff content',
      metadata: { role: 'planner' }
    });
    workflowEngine.addTaskOutput({
      workflowId: monitorWorkflowId,
      taskId: reviewerClaim.task.taskId,
      kind: 'result',
      name: 'monitor-result',
      content: 'monitor result content',
      metadata: { role: 'reviewer' }
    });

    await adminServer.listen(0, ADMIN_SERVER_DEFAULT_HOST);
    const address = adminServer.server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    assert(Number.isInteger(port) && port > 0, 'admin server should listen on a real port');

    const page = await request({ port, method: 'GET', pathname: '/' });
    assert(page.statusCode === 200, 'GET / should return 200');
    assert(page.text.includes('workflow-closure ops panel'), 'GET / should serve the ops panel html');

    const appJs = await request({ port, method: 'GET', pathname: '/app.js' });
    assert(appJs.statusCode === 200, 'GET /app.js should return 200');
    assert(appJs.text.includes('runResume'), 'GET /app.js should serve the client app');
    assert(appJs.text.includes('renderExecutionTimeline'), 'GET /app.js should expose timeline rendering');
    assert(appJs.text.includes('renderWorkflowDag'), 'GET /app.js should expose workflow DAG rendering');
    assert(appJs.text.includes('renderTimelineEventInspector'), 'GET /app.js should expose event inspector rendering');
    assert(appJs.text.includes('syncLiveUpdates'), 'GET /app.js should expose live updates wiring');
    assert(appJs.text.includes('state.filters.workflowId'), 'GET /app.js should connect live updates from workflow filters');
    assert(appJs.text.includes('state.filters.chainId'), 'GET /app.js should connect live updates from chain filters');
    assert(appJs.text.includes('Live overview'), 'GET /app.js should render live status without a selected assignment or handoff');
    assert(!appJs.text.includes('if (!assignment && !handoff) {\n    return \'\';\n  }'), 'GET /app.js should not require selected rows before opening live updates');
    assert(appJs.text.includes('includeHistory'), 'GET /app.js should expose history filter wiring');
    assert(appJs.text.includes('History / Audit'), 'GET /app.js should expose history grouping');
    assert(appJs.text.includes('Actionable open'), 'GET /app.js should expose clean handoff grouping');
    assert(appJs.text.includes('Needs cleanup / noisy'), 'GET /app.js should expose noisy handoff grouping');
    assert(appJs.text.includes('renderHandoffStructuredSections'), 'GET /app.js should expose structured handoff rendering');
    assert(appJs.text.includes('classifyHandoffForDisplay'), 'GET /app.js should expose handoff display classification');
    assert(appJs.text.includes('artifactRefs'), 'GET /app.js should expose handoff artifact refs');
    assert(appJs.text.includes('recommendedNextRole'), 'GET /app.js should expose handoff routing fields');
    assert(appJs.text.includes('renderMemoryLineage'), 'GET /app.js should expose memory lineage rendering');
    assert(appJs.text.includes('renderMemoryInspector'), 'GET /app.js should expose memory inspector rendering');
    assert(appJs.text.includes('data-graph-kind="memory"'), 'GET /app.js should expose memory graph markup');
    assert(appJs.text.includes('renderWorkflowRecoveryCard'), 'GET /app.js should expose new-window workflow recovery guidance');
    assert(appJs.text.includes('resume-session'), 'GET /app.js should show the resume-session command for workflow recovery');
    assert(appJs.text.includes('claude-main'), 'GET /app.js should show the stable worker id for session recovery');
    assert(appJs.text.includes('同一 workerId 用于续接'), 'GET /app.js should explain same worker id recovery semantics');
    assert(appJs.text.includes('不同 workerId 用于并行执行'), 'GET /app.js should explain different worker id parallel semantics');
    assert(appJs.text.includes('New window recovery'), 'GET /app.js should label workflow recovery details clearly');
    assert(appJs.text.includes('DB profile'), 'GET /app.js should display the active DB profile in recovery guidance');
    assert(appJs.text.includes('DB source'), 'GET /app.js should display the active DB source in recovery guidance');
    assert(!appJs.text.includes('const DB_SCOPE_LABELS'), 'GET /app.js should not duplicate DB scope label definitions');
    assert(appJs.text.includes('./db-scope-config.js'), 'GET /app.js should import the browser DB scope helper');
    assert(appJs.text.includes('cliPath'), 'GET /app.js should build recovery commands from runtime cliPath metadata');
    assert(!appJs.text.includes('C:/workspace/workflow-closure/cli.js'), 'GET /app.js should not hardcode a repo-specific CLI path');
    assert(appJs.text.includes('renderWorkflowMonitor'), 'GET /app.js should expose workflow monitor rendering');
    assert(appJs.text.includes('Claude windows / workers'), 'GET /app.js should label active workflow windows');
    assert(appJs.text.includes('mergeWorkflowMonitorState'), 'GET /app.js should persist monitor state from fetches and SSE');

    const apiRoutesJs = await request({ port, method: 'GET', pathname: '/api-routes.js' });
    assert(apiRoutesJs.statusCode === 200, 'GET /api-routes.js should return 200');
    assert(apiRoutesJs.text.includes('AdminApiRoutes'), 'GET /api-routes.js should serve the admin API route helper');
    assert(apiRoutesJs.text.includes(ADMIN_API_PATHS.liveUpdates), 'GET /api-routes.js should expose live updates path');
    assert(apiRoutesJs.text.includes(ADMIN_API_PATHS.assignNextWork), 'GET /api-routes.js should expose action paths');
    assert(AdminApiRoutes.paths.liveUpdates === ADMIN_API_PATHS.liveUpdates, 'browser route helper should match the Node live updates path');
    assert(AdminApiRoutes.paths.assignNextWork === ADMIN_API_PATHS.assignNextWork, 'browser route helper should match the Node assign path');
    assert(AdminApiRoutes.coordinatorState({ assignmentLimit: 50, handoffLimit: 50 }) === buildAdminApiPath.coordinatorState({ assignmentLimit: 50, handoffLimit: 50 }), 'browser route helper should match the Node coordinator-state builder');
    assert(AdminApiRoutes.workflow('admin-ui route smoke') === buildAdminApiPath.workflow('admin-ui route smoke'), 'browser route helper should match the Node workflow builder');
    assert(AdminApiRoutes.workflowMemory('admin-ui route smoke') === buildAdminApiPath.workflowMemory('admin-ui route smoke'), 'browser route helper should match the Node workflow memory builder');
    assert(AdminApiRoutes.workflowMonitor('admin-ui route smoke') === buildAdminApiPath.workflowMonitor('admin-ui route smoke'), 'browser route helper should match the Node workflow monitor builder');

    const dbScopeConfigJs = await request({ port, method: 'GET', pathname: '/db-scope-config.js' });
    assert(dbScopeConfigJs.statusCode === 200, 'GET /db-scope-config.js should return 200');
    assert(dbScopeConfigJs.text.includes('DB_PATH_SOURCES'), 'GET /db-scope-config.js should expose DB source constants');
    assert(dbScopeConfigJs.text.includes('explicit-db-path'), 'GET /db-scope-config.js should expose explicit DB scope wording');
    assert(dbScopeConfigJs.text.includes('isolated-db-profile'), 'GET /db-scope-config.js should expose profile DB scope wording');
    assert(dbScopeConfigJs.text.includes('formatRuntimeDbScope'), 'GET /db-scope-config.js should expose runtime DB scope formatting');
    assert(dbScopeConfigJs.text.includes('createRuntimeRecoverySelector'), 'GET /db-scope-config.js should expose recovery selector logic');

    const styles = await request({ port, method: 'GET', pathname: '/styles.css' });
    assert(styles.statusCode === 200, 'GET /styles.css should return 200');
    assert(styles.text.includes('.assignment-actions'), 'GET /styles.css should serve the assignment action styles');
    assert(styles.text.includes('.timeline-item'), 'GET /styles.css should serve timeline styles');
    assert(styles.text.includes('.dag-columns'), 'GET /styles.css should serve DAG styles');
    assert(styles.text.includes('.event-inspector'), 'GET /styles.css should serve event inspector styles');
    assert(styles.text.includes('.live-strip'), 'GET /styles.css should serve live execution styles');
    assert(styles.text.includes('.graph-shell'), 'GET /styles.css should serve graph shell styles');
    assert(styles.text.includes('.memory-graph-shell'), 'GET /styles.css should serve memory graph styles');
    assert(styles.text.includes('.memory-inspector'), 'GET /styles.css should serve memory inspector styles');
    assert(styles.text.includes('.handoff-signal-row'), 'GET /styles.css should serve handoff signal styles');
    assert(styles.text.includes('.handoff-detail-grid'), 'GET /styles.css should serve handoff detail styles');
    assert(styles.text.includes('.signal-chip.warning'), 'GET /styles.css should serve handoff warning signal styles');
    assert(styles.text.includes('.graph-edge.status-ready'), 'GET /styles.css should serve animated graph connector styles');
    assert(styles.text.includes('.recovery-card'), 'GET /styles.css should serve workflow recovery card styles');
    assert(styles.text.includes('.command-snippet'), 'GET /styles.css should serve workflow recovery command styles');
    assert(styles.text.includes('.monitor-shell'), 'GET /styles.css should serve workflow monitor shell styles');
    assert(styles.text.includes('.monitor-section'), 'GET /styles.css should serve workflow monitor section styles');
    assert(styles.text.includes('.monitor-task-board'), 'GET /styles.css should serve workflow monitor task board styles');

    const initialState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.coordinatorState({ assignmentLimit: 50, handoffLimit: 50 })
    });
    assert(initialState.statusCode === 200, 'GET /api/coordinator-state should return 200');
    assert(initialState.json.status === 'ok', 'coordinator state endpoint should return ok status');
    assert(Array.isArray(initialState.json.agents), 'coordinator state endpoint should expose agents');
    assert(Array.isArray(initialState.json.assignments), 'coordinator state endpoint should expose assignments');
    assert(Array.isArray(initialState.json.handoffs), 'coordinator state endpoint should expose handoffs');
    assert(initialState.json.summary?.agentCount === 3, 'coordinator state summary should count the registered agents');
    assert(Array.isArray(initialState.json.allowedNextCommands), 'coordinator state endpoint should expose allowed next commands');
    assert(initialState.json.runtime?.dbPath === dbPath, 'coordinator state endpoint should expose the active DB path');
    assert(initialState.json.runtime?.dbPathSource === 'explicit', 'coordinator state endpoint should expose explicit DB source');
    assert(initialState.json.runtime?.dbScopeLabel === 'explicit-db-path', 'coordinator state endpoint should expose the active DB scope label');
    assert(initialState.json.runtime?.cliPath === path.join(rootDir, 'cli.js'), 'coordinator state endpoint should expose the CLI path for recovery commands');
    assert(String(initialState.json.runtime?.workspacePath || '').toLowerCase() === path.resolve(rootDir).toLowerCase(), 'coordinator state endpoint should expose workspace path');

    const assigned = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.assignNextWork,
      body: {
        chainId: resumeFixture.chain.chainId
      }
    });
    assert(assigned.statusCode === 200, 'POST /api/assign-next-work should return 200');
    assert(assigned.json.status === 'assigned', 'assign endpoint should create an assignment');
    assert(assigned.json.result?.assignment?.chainId === resumeFixture.chain.chainId, 'assign endpoint should target the requested chain');
    assert(assigned.json.result?.agent?.agentId === researcher.agentId, 'assign endpoint should pick the researcher first');

    const firstRun = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.runNextAssignment,
      body: {
        assignmentId: assigned.json.result.assignment.assignmentId,
        maxStages: 1,
        maxWorkflowSteps: 20
      }
    });
    assert(firstRun.statusCode === 200, 'POST /api/run-next-assignment should return 200');
    assert(firstRun.json.status === 'done', 'run endpoint should complete the assigned researcher stage');
    assert(firstRun.json.result?.agent?.agentId === researcher.agentId, 'run endpoint should execute the selected assignment');

    const blockedRun = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.runNextAssignment,
      body: {
        chainId: resumeFixture.chain.chainId,
        maxStages: 1,
        maxWorkflowSteps: 20
      }
    });
    assert(blockedRun.statusCode === 200, 'run endpoint should still return 200 for blocked work');
    assert(blockedRun.json.status === 'blocked', 'run endpoint should expose blocked status when implementer blocks');
    const blockedAssignment = blockedRun.json.result?.assignment;
    assert(blockedAssignment?.status === 'blocked', 'blocked run should expose the blocked assignment');

    const resumed = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.resumeAssignedWork,
      body: {
        assignmentId: blockedAssignment.assignmentId,
        targetType: blockedAssignment.targetType,
        workflowId: blockedAssignment.workflowId,
        chainId: blockedAssignment.chainId,
        taskId: blockedAssignment.taskId,
        stageId: blockedAssignment.stageId,
        agentId: blockedAssignment.agentId,
        mode: 'resume',
        runNow: false,
        message: 'ops panel smoke resume'
      }
    });
    assert(resumed.statusCode === 200, 'POST /api/resume-assigned-work should return 200 for resume');
    assert(resumed.json.status === 'resumed', 'resume endpoint should expose resumed status');
    assert(resumed.json.mode === 'resume', 'resume endpoint should echo resume mode');

    const resumedRun = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.runNextAssignment,
      body: {
        assignmentId: resumed.json.result.assignment.assignmentId,
        maxStages: 1,
        maxWorkflowSteps: 20
      }
    });
    assert(resumedRun.json.status === 'done', 'resumed assignment should run to completion');
    assert(resumedRun.json.result?.agent?.agentId === primaryImplementer.agentId, 'resume should keep the original implementer');

    const resumeVerify = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.runNextAssignment,
      body: {
        chainId: resumeFixture.chain.chainId,
        maxStages: 1,
        maxWorkflowSteps: 20
      }
    });
    assert(resumeVerify.json.status === 'done', 'resume flow should finish the verifier stage');
    assert(resumeVerify.json.result?.agent?.agentId === verifier.agentId, 'resume flow should hand off to verifier');

    const reassignResearch = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.runNextAssignment,
      body: {
        chainId: reassignFixture.chain.chainId,
        maxStages: 1,
        maxWorkflowSteps: 20
      }
    });
    assert(reassignResearch.json.status === 'done', 'reassign flow should complete the research stage first');

    const reassignBlocked = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.runNextAssignment,
      body: {
        chainId: reassignFixture.chain.chainId,
        maxStages: 1,
        maxWorkflowSteps: 20
      }
    });
    assert(reassignBlocked.json.status === 'blocked', 'reassign flow should block on the primary implementer');
    const reassignBlockedAssignment = reassignBlocked.json.result?.assignment;
    assert(reassignBlockedAssignment?.status === 'blocked', 'reassign flow should expose the blocked assignment');

    backupImplementer = adminServer.coordinator.registerAgent({
      agentId: 'admin-ui-implementer-backup',
      name: 'Admin UI Implementer Backup',
      role: 'implementer',
      capabilities: ['implement', 'handoff'],
      status: 'active',
      adapter: async ({ task }) => ({
        status: 'done',
        doneSummary: `备用实现完成：${task.title}`,
        taskOutputs: [
          {
            kind: 'artifact',
            name: 'backup-implementation-summary',
            content: `备用实现产物：${task.title}`,
            path: 'scripts/.tmp/admin-ui/backup-implementation-summary.txt',
            metadata: {
              role: 'implementer-backup',
              taskTitle: task.title
            }
          }
        ],
        handoff: {
          summary: '备用实现已完成，可交给 verifier。',
          artifacts: ['ops-panel-backup.patch'],
          decisions: ['通过 reassign 完成恢复'],
          openQuestions: [],
          risks: [],
          recommendedNextRole: 'verifier'
        }
      })
    });
    assert(backupImplementer?.agentId, 'smoke test should register the backup implementer before reassign');

    const reassigned = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.resumeAssignedWork,
      body: {
        assignmentId: reassignBlockedAssignment.assignmentId,
        targetType: reassignBlockedAssignment.targetType,
        workflowId: reassignBlockedAssignment.workflowId,
        chainId: reassignBlockedAssignment.chainId,
        taskId: reassignBlockedAssignment.taskId,
        stageId: reassignBlockedAssignment.stageId,
        agentId: backupImplementer.agentId,
        mode: 'reassign',
        runNow: false,
        message: 'ops panel smoke reassign'
      }
    });
    assert(reassigned.statusCode === 200, 'reassign endpoint should return 200');
    assert(reassigned.json.status === 'reassigned', 'reassign endpoint should expose reassigned status');
    assert(reassigned.json.mode === 'reassign', 'reassign endpoint should echo reassign mode');
    assert(reassigned.json.result?.assignment?.agentId === backupImplementer.agentId, 'reassign should move the work to the backup implementer');

    const reassignedRun = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.runNextAssignment,
      body: {
        assignmentId: reassigned.json.result.assignment.assignmentId,
        maxStages: 1,
        maxWorkflowSteps: 20
      }
    });
    assert(reassignedRun.json.status === 'done', 'reassigned assignment should run to completion');
    assert(reassignedRun.json.result?.agent?.agentId === backupImplementer.agentId, 'reassigned run should use the backup implementer');

    const reassignVerify = await requestJson({
      port,
      method: 'POST',
      pathname: ADMIN_API_PATHS.runNextAssignment,
      body: {
        chainId: reassignFixture.chain.chainId,
        maxStages: 1,
        maxWorkflowSteps: 20
      }
    });
    assert(reassignVerify.json.status === 'done', 'reassign flow should finish the verifier stage');
    assert(reassignVerify.json.result?.agent?.agentId === verifier.agentId, 'reassign flow should end on verifier');

    const rerunInitial = await chain.runChain({
      chainId: rerunFixture.chain.chainId,
      maxStages: 10,
      maxWorkflowSteps: 20
    });
    assert(rerunInitial.status === 'done', 'rerun fixture should finish before rerun restart');
    const rerunStage = rerunInitial.state.stages.find((stage) => stage.title === '第二阶段');
    assert(rerunStage?.workflowId, 'rerun fixture should produce a workflow for the rerun stage');

    const rerunChainStateBeforeRestart = chain.getChainState({
      chainId: rerunFixture.chain.chainId,
      includeWorkflowStates: true
    });
    const rerunWorkflowStateBeforeRestart = rerunChainStateBeforeRestart.workflowStates[rerunStage.stageId];
    const rerunOriginTask = rerunWorkflowStateBeforeRestart.tasks.find((task) => task.title === '改写错误结论');
    assert(rerunOriginTask, 'rerun fixture should contain the rerun origin task');

    const rerunReason = '第二阶段引用了错误上游事实，chain 需要从错误起点重跑';
    const restartedChain = await chain.restartChainFromStage({
      chainId: rerunFixture.chain.chainId,
      stageId: rerunStage.stageId,
      taskId: rerunOriginTask.taskId,
      reason: rerunReason,
      fingerprint: 'admin-ui-rerun-smoke',
      operator: 'admin-ui-smoke-test',
      payload: { operator: 'admin-ui-smoke-test', mode: 'rerun' },
      maxSameFingerprintReruns: 2
    });
    assert(restartedChain.rerun?.rerunId, 'restartChainFromStage should create a chain rerun record for admin observability');

    const rerunAfterRestart = await chain.runChain({
      chainId: rerunFixture.chain.chainId,
      maxStages: 10,
      maxWorkflowSteps: 20
    });
    assert(rerunAfterRestart.status === 'done', 'rerun fixture should finish after restartChainFromStage');

    const chainState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.chain(reassignFixture.chain.chainId, {
        includeRunLogs: true,
        includeReruns: true,
        includeRevisions: true,
        limit: 50
      })
    });
    assert(chainState.statusCode === 200, 'GET /api/chains/:chainId should return 200');
    assert(chainState.json.status === 'ok', 'chain state endpoint should return ok status');
    assert(chainState.json.chainState?.chain?.chainId === reassignFixture.chain.chainId, 'chain state endpoint should expose the requested chain');
    assert(Array.isArray(chainState.json.chainState?.stages), 'chain state endpoint should expose stages');
    assert(Array.isArray(chainState.json.chainState?.runLogs), 'chain state endpoint should expose run logs when requested');
    assert(Array.isArray(chainState.json.chainState?.reruns), 'chain state endpoint should expose reruns');
    assert(Array.isArray(chainState.json.chainState?.stageRevisions), 'chain state endpoint should expose stage revisions');
    assert(Array.isArray(chainState.json.chainState?.workflowStates), 'chain state endpoint should aggregate workflow states for chain stages');
    assert(chainState.json.chainState.workflowStates.length >= 1, 'chain state endpoint should include at least one workflow state for completed chain stages');

    const workflowId = reassignBlockedAssignment.workflowId
      || chainState.json.chainState?.stages?.find((stage) => stage.stageId === reassignBlockedAssignment.stageId)?.workflowId
      || chainState.json.chainState?.nextStage?.workflowId
      || chainState.json.chainState?.workflowStates?.[0]?.workflow?.workflowId;
    assert(workflowId, 'reassign blocked assignment should resolve workflowId from assignment or chain details for workflow detail checks');
    const verifierWorkflowId = chainState.json.chainState?.stages?.find((stage) => stage.title === '验证 reassign 结果')?.workflowId
      || chainState.json.chainState?.workflowStates?.find((state) => state.taskOutputs?.some((output) => output.name === 'verification-report'))?.workflow?.workflowId;
    assert(verifierWorkflowId, 'reassign verifier stage should resolve workflowId for generated output checks');
    const workflowState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.workflow(workflowId, {
        includeRunLogs: true,
        includeReruns: true,
        includeRevisions: true,
        includeOutputs: true,
        limit: 50
      })
    });
    assert(workflowState.statusCode === 200, 'GET /api/workflows/:workflowId should return 200');
    assert(workflowState.json.status === 'ok', 'workflow state endpoint should return ok status');
    assert(workflowState.json.workflowState?.workflow?.workflowId === workflowId, 'workflow state endpoint should expose the requested workflow');
    assert(Array.isArray(workflowState.json.workflowState?.tasks), 'workflow state endpoint should expose tasks');
    assert(Array.isArray(workflowState.json.workflowState?.dependencies), 'workflow state endpoint should expose dependencies');
    assert(Array.isArray(workflowState.json.workflowState?.runLogs), 'workflow state endpoint should expose run logs');
    assert(Array.isArray(workflowState.json.workflowState?.reruns), 'workflow state endpoint should expose reruns');
    assert(Array.isArray(workflowState.json.workflowState?.taskRevisions), 'workflow state endpoint should expose task revisions');
    assert(Array.isArray(workflowState.json.workflowState?.taskOutputs), 'workflow state endpoint should expose task outputs');
    assert(workflowState.json.workflowState?.runtime?.dbPath === dbPath, 'workflow state endpoint should expose runtime DB path');
    assert(workflowState.json.workflowState?.runtime?.dbPathSource === 'explicit', 'workflow state endpoint should expose runtime DB source');
    assert(workflowState.json.workflowState.tasks.length >= 1, 'workflow state endpoint should include workflow tasks');
    assert(workflowState.json.workflowState.taskOutputs.length >= 1, 'workflow state endpoint should include persisted task outputs from done tasks');
    assert(workflowState.json.workflowState.taskOutputs.some((output) => output.content && output.content.includes('实现产物')), 'workflow task outputs should preserve output content');
    const materializedAdminOutput = workflowState.json.workflowState.taskOutputs.find((output) => output.name === 'backup-implementation-summary');
    assert(materializedAdminOutput?.path === 'scripts/.tmp/admin-ui/backup-implementation-summary.txt', 'workflow state endpoint should preserve artifact output path');
    assert(materializedAdminOutput?.metadata?.artifactRef === 'file:scripts/.tmp/admin-ui/backup-implementation-summary.txt', 'workflow state endpoint should expose artifactRef metadata for materialized outputs');
    assert(materializedAdminOutput?.metadata?.storageStatus === 'written', 'workflow state endpoint should expose written storage status for materialized outputs');
    assert(materializedAdminOutput?.metadata?.relativePath === 'scripts/.tmp/admin-ui/backup-implementation-summary.txt', 'workflow state endpoint should expose normalized relative path metadata');
    assert(materializedAdminOutput?.metadata?.workspacePath?.replaceAll('\\', '/').toLowerCase() === rootDir.replaceAll('\\', '/').toLowerCase(), 'workflow state endpoint should preserve normalized workspace path metadata');
    const verificationWorkflowState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.workflow(verifierWorkflowId, {
        includeRunLogs: true,
        includeOutputs: true,
        limit: 50
      })
    });
    assert(verificationWorkflowState.statusCode === 200, 'GET verifier workflow details should return 200');
    assert(verificationWorkflowState.json.status === 'ok', 'verifier workflow state endpoint should return ok status');
    assert(verificationWorkflowState.json.workflowState?.workflow?.workflowId === verifierWorkflowId, 'verifier workflow details should expose the requested workflow');
    const generatedVerificationOutput = verificationWorkflowState.json.workflowState.taskOutputs.find((output) => output.name === 'verification-report');
    assert(generatedVerificationOutput?.path?.startsWith(`artifacts/workflows/${verifierWorkflowId}/`), 'workflow state endpoint should generate a default path for pathless verification outputs');
    assert(generatedVerificationOutput?.path?.includes('/validation/verification-report-'), 'workflow state endpoint should route verification outputs into the validation directory');
    assert(generatedVerificationOutput?.metadata?.artifactRef === `file:${generatedVerificationOutput.path}`, 'workflow state endpoint should expose artifactRef metadata for generated verification outputs');
    assert(generatedVerificationOutput?.metadata?.storageStatus === 'written', 'workflow state endpoint should expose written storage status for generated verification outputs');
    assert(generatedVerificationOutput?.metadata?.relativePath === generatedVerificationOutput.path, 'workflow state endpoint should expose normalized generated relative path metadata');
    assert(generatedVerificationOutput?.metadata?.workspacePath?.replaceAll('\\', '/').toLowerCase() === rootDir.replaceAll('\\', '/').toLowerCase(), 'workflow state endpoint should preserve workspacePath metadata for generated verification outputs');
    const generatedVerificationArtifact = await fs.readFile(path.join(rootDir, generatedVerificationOutput.path), 'utf8');
    assert(generatedVerificationArtifact.includes('验证通过'), 'generated verification output should materialize content into the workspace');
    const materializedAdminArtifact = await fs.readFile(path.join(rootDir, 'scripts', '.tmp', 'admin-ui', 'backup-implementation-summary.txt'), 'utf8');
    assert(materializedAdminArtifact.includes('实现产物'), 'materialized admin-ui artifact should be written into the workspace');
    assert(workflowState.json.workflowState.runLogs.some((log) => log.action === 'task_resumed' || log.action === 'task_reassigned' || log.action === 'task_completed_by_runner'), 'workflow run logs should expose real task lifecycle history');

    const monitorWorkflowState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.workflow(monitorWorkflowId, {
        includeRunLogs: true,
        includeOutputs: true,
        limit: 50
      })
    });
    assert(monitorWorkflowState.statusCode === 200, 'GET monitor workflow details should return 200');
    assert(monitorWorkflowState.json.status === 'ok', 'monitor workflow state endpoint should return ok status');
    assert(monitorWorkflowState.json.workflowState?.workflow?.workflowId === monitorWorkflowId, 'monitor workflow state endpoint should expose the requested workflow');
    assert(monitorWorkflowState.json.monitorState?.workflowId === monitorWorkflowId, 'workflow state endpoint should include monitorState');
    assert(Array.isArray(monitorWorkflowState.json.monitorState?.activeWindows), 'monitorState should expose active windows');
    assert(Array.isArray(monitorWorkflowState.json.monitorState?.workers), 'monitorState should expose workers');
    assert(Array.isArray(monitorWorkflowState.json.monitorState?.taskBoard), 'monitorState should expose task board rows');
    assert(Array.isArray(monitorWorkflowState.json.monitorState?.recentEvents), 'monitorState should expose recent events');
    assert(Array.isArray(monitorWorkflowState.json.monitorState?.recentOutputs), 'monitorState should expose recent outputs');
    assert(monitorWorkflowState.json.monitorState.workers.some((worker) => worker.workerId === 'planner-agent' && worker.leaseState === 'active'), 'monitorState should expose the active planner window');
    assert(monitorWorkflowState.json.monitorState.workers.some((worker) => worker.workerId === 'reviewer-agent' && worker.leaseState === 'active'), 'monitorState should expose the active reviewer window');
    assert(monitorWorkflowState.json.monitorState.taskBoard.some((task) => task.leaseOwner === 'planner-agent' && task.status === 'doing'), 'monitor task board should expose planner task ownership');
    assert(monitorWorkflowState.json.monitorState.taskBoard.some((task) => task.leaseOwner === 'reviewer-agent' && task.status === 'doing'), 'monitor task board should expose reviewer task ownership');
    assert(monitorWorkflowState.json.monitorState.recentEvents.some((event) => event.action === 'task_claimed'), 'monitorState should expose recent claim events');
    assert(monitorWorkflowState.json.monitorState.recentOutputs.some((output) => output.kind === 'handoff' && output.name === 'monitor-handoff'), 'monitorState should expose captured handoff outputs');
    assert(monitorWorkflowState.json.monitorState.recentOutputs.some((output) => output.kind === 'result' && output.name === 'monitor-result'), 'monitorState should expose captured result outputs');
    const monitorApiState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.workflowMonitor(monitorWorkflowId, {
        includeRunLogs: true,
        includeOutputs: true,
        limit: 50
      })
    });
    assert(monitorApiState.statusCode === 200, 'GET /api/workflows/:workflowId/monitor should return 200');
    assert(monitorApiState.json.status === 'ok', 'monitor endpoint should return ok status');
    assert(monitorApiState.json.monitorState?.workflowId === monitorWorkflowId, 'monitor endpoint should expose the requested monitor state');
    assert(monitorApiState.json.runtime?.dbPath === dbPath, 'monitor endpoint should expose runtime DB path');
    assert(monitorApiState.json.runtime?.dbPathSource === 'explicit', 'monitor endpoint should expose runtime DB source');

    const memorySystem = await createAgentMemorySystem({ dbPath });
    const workflowTask = workflowState.json.workflowState.tasks.find((task) => task.taskId === reassignBlockedAssignment.taskId)
      || workflowState.json.workflowState.tasks.find((task) => String(task.title || '').includes('实现 reassign 场景'))
      || workflowState.json.workflowState.tasks[0];
    assert(workflowTask?.taskId, 'workflow detail checks should resolve a concrete task for memory observability');
    const workflowTaskSourceRef = createWorkflowTaskSourceRef(workflowId, workflowTask.taskId);
    const exactMemorySeed = memorySystem.remember({
      type: 'project',
      scope: 'workspace',
      title: 'Admin UI exact memory seed',
      summary: 'Exact task memory should appear in the admin memory lane.',
      content: 'Admin UI exact memory fixture bound to the selected workflow task.',
      projectKey: 'workflow-closure',
      workspacePath: rootDir,
      sessionId: 'admin-ui-smoke-test',
      tags: ['admin-ui', 'exact'],
      sourceKind: 'workflow-task',
      sourceRef: workflowTaskSourceRef,
      subjectKind: 'workflow-task',
      subjectRef: workflowTaskSourceRef,
      workflowId,
      taskId: workflowTask.taskId
    });
    const structuralMemorySeed = memorySystem.remember({
      type: 'project',
      scope: 'workspace',
      title: 'Admin UI structural memory seed',
      summary: 'Structured task memory should appear in the structural lane.',
      content: 'Admin UI structural memory fixture for the same workflow task.',
      projectKey: 'workflow-closure',
      workspacePath: rootDir,
      sessionId: 'admin-ui-smoke-test',
      tags: ['admin-ui', 'structural'],
      sourceKind: 'workflow-task-rerun',
      sourceRef: 'admin-ui-smoke-test:structural-memory',
      subjectKind: 'workflow-task-rerun',
      subjectRef: workflowTaskSourceRef,
      workflowId,
      taskId: workflowTask.taskId,
      eventKind: 'rerun'
    });
    const graphMemorySeed = memorySystem.remember({
      type: 'project',
      scope: 'workspace',
      title: 'Admin UI graph linked seed',
      summary: 'Graph-linked memory should appear in the memory lineage graph.',
      content: 'Admin UI graph-linked memory fixture reachable through memory links.',
      projectKey: 'workflow-closure',
      workspacePath: rootDir,
      sessionId: 'admin-ui-smoke-test',
      tags: ['admin-ui', 'graph'],
      sourceKind: 'smoke-test',
      sourceRef: 'admin-ui-smoke-test:graph-linked-memory',
      links: [
        {
          targetMemoryId: exactMemorySeed.memory.memoryId,
          relation: 'supports'
        }
      ]
    });

    const workflowMemoryState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.workflowMemory(workflowId, {
        taskId: workflowTask.taskId,
        limit: 12
      })
    });
    assert(workflowMemoryState.statusCode === 200, 'GET /api/workflows/:workflowId/memory should return 200');
    assert(workflowMemoryState.json.status === 'ok', 'workflow memory endpoint should return ok status');
    assert(workflowMemoryState.json.memoryState?.workflowId === workflowId, 'workflow memory endpoint should expose the requested workflow');
    assert(workflowMemoryState.json.memoryState?.taskId === workflowTask.taskId, 'workflow memory endpoint should expose the selected task');
    assert(Array.isArray(workflowMemoryState.json.memoryState?.items), 'workflow memory endpoint should expose selected memory items');
    assert(Array.isArray(workflowMemoryState.json.memoryState?.exactItems), 'workflow memory endpoint should expose exactItems');
    assert(Array.isArray(workflowMemoryState.json.memoryState?.structuralItems), 'workflow memory endpoint should expose structuralItems');
    assert(Array.isArray(workflowMemoryState.json.memoryState?.graphItems), 'workflow memory endpoint should expose graphItems');
    assert(Array.isArray(workflowMemoryState.json.memoryState?.selectedReasons), 'workflow memory endpoint should expose selectedReasons');
    assert(workflowMemoryState.json.memoryState.exactItems.some((item) => item.memoryId === exactMemorySeed.memory.memoryId), 'workflow memory endpoint should surface exact task memory');
    assert(workflowMemoryState.json.memoryState.structuralItems.some((item) => item.memoryId === structuralMemorySeed.memory.memoryId), 'workflow memory endpoint should surface structural task memory');
    const graphMemoryItem = workflowMemoryState.json.memoryState.graphItems.find((item) => item.memoryId === graphMemorySeed.memory.memoryId);
    assert(graphMemoryItem, 'workflow memory endpoint should surface graph-linked memory');
    assert(graphMemoryItem.matchedBy?.graph === true, 'graph-linked memory should record matchedBy.graph');
    assert(Array.isArray(graphMemoryItem.matchedBy?.graphSeedMemoryIds) && graphMemoryItem.matchedBy.graphSeedMemoryIds.includes(exactMemorySeed.memory.memoryId), 'graph-linked memory should expose graph seed memory ids');
    assert(Array.isArray(graphMemoryItem.matchedBy?.graphRelations) && graphMemoryItem.matchedBy.graphRelations.includes('supports'), 'graph-linked memory should expose graph relations');
    assert(workflowMemoryState.json.memoryState.selectedReasons.includes('exact-memory'), 'workflow memory endpoint should include exact-memory selected reason');
    assert(workflowMemoryState.json.memoryState.selectedReasons.includes('structural-memory'), 'workflow memory endpoint should include structural-memory selected reason');
    assert(workflowMemoryState.json.memoryState.selectedReasons.includes('graph-memory'), 'workflow memory endpoint should include graph-memory selected reason');
    assert(Array.isArray(workflowMemoryState.json.memoryState?.graph?.nodes), 'workflow memory endpoint should expose graph nodes');
    assert(Array.isArray(workflowMemoryState.json.memoryState?.graph?.edges), 'workflow memory endpoint should expose graph edges');
    assert(workflowMemoryState.json.memoryState.graph.nodes.some((node) => node.kind === 'task' && node.taskId === workflowTask.taskId), 'workflow memory graph should include the selected task node');
    assert(workflowMemoryState.json.memoryState.graph.nodes.some((node) => node.memoryId === exactMemorySeed.memory.memoryId && node.lane === 'exact'), 'workflow memory graph should include exact memory nodes');
    assert(workflowMemoryState.json.memoryState.graph.nodes.some((node) => node.memoryId === structuralMemorySeed.memory.memoryId && node.lane === 'structural'), 'workflow memory graph should include structural memory nodes');
    assert(workflowMemoryState.json.memoryState.graph.nodes.some((node) => node.memoryId === graphMemorySeed.memory.memoryId && node.lane === 'graph'), 'workflow memory graph should include graph memory nodes');
    assert(workflowMemoryState.json.memoryState.graph.edges.some((edge) => edge.source === `task:${workflowTask.taskId}` && edge.target === `memory:${exactMemorySeed.memory.memoryId}` && edge.kind === 'selected'), 'workflow memory graph should connect the task to exact memory');
    assert(workflowMemoryState.json.memoryState.graph.edges.some((edge) => edge.source === `memory:${graphMemorySeed.memory.memoryId}` && edge.target === `memory:${exactMemorySeed.memory.memoryId}` && edge.kind === 'memory-link' && edge.relation === 'supports'), 'workflow memory graph should preserve memory-link relations');

    const memoryState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.memory(graphMemorySeed.memory.memoryId, {
        includeEvents: true,
        includeLinks: true,
        limit: 12
      })
    });
    assert(memoryState.statusCode === 200, 'GET /api/memories/:memoryId should return 200');
    assert(memoryState.json.status === 'ok', 'memory state endpoint should return ok status');
    assert(memoryState.json.memoryState?.memory?.memoryId === graphMemorySeed.memory.memoryId, 'memory state endpoint should expose the requested memory');
    assert(Array.isArray(memoryState.json.memoryState?.tags), 'memory state endpoint should expose tags');
    assert(Array.isArray(memoryState.json.memoryState?.links), 'memory state endpoint should expose links');
    assert(Array.isArray(memoryState.json.memoryState?.events), 'memory state endpoint should expose events');
    assert(memoryState.json.memoryState.links.some((link) => link.targetMemoryId === exactMemorySeed.memory.memoryId && link.relation === 'supports'), 'memory state endpoint should preserve outgoing memory links');
    assert(memoryState.json.memoryState.events.length >= 1, 'memory state endpoint should expose persisted memory events');
    assert(memoryState.json.memoryState.events.some((event) => event.action === 'created'), 'memory state endpoint should expose the memory creation event');

    const rerunChainState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.chain(rerunFixture.chain.chainId, {
        includeRunLogs: true,
        includeReruns: true,
        includeRevisions: true,
        limit: 50
      })
    });

    const liveUpdates = await request({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.liveUpdates({
        chainId: reassignFixture.chain.chainId,
        workflowId,
        limit: 10
      })
    });
    assert(liveUpdates.statusCode === 200, 'GET /api/live-updates should return 200');
    assert(String(liveUpdates.headers['content-type'] || '').includes('text/event-stream'), 'live updates endpoint should return an event stream');
    assert(liveUpdates.text.includes('event: summary'), 'live updates stream should include summary events');
    assert(liveUpdates.text.includes('event: chain'), 'live updates stream should include chain events');
    assert(liveUpdates.text.includes('event: workflow'), 'live updates stream should include workflow events');
    assert(liveUpdates.text.includes('event: heartbeat'), 'live updates stream should include heartbeat events');

    const monitorLiveUpdates = await request({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.liveUpdates({
        workflowId: monitorWorkflowId,
        limit: 10
      })
    });
    assert(monitorLiveUpdates.statusCode === 200, 'GET monitor live updates should return 200');
    assert(String(monitorLiveUpdates.headers['content-type'] || '').includes('text/event-stream'), 'monitor live updates endpoint should return an event stream');
    assert(monitorLiveUpdates.text.includes('event: workflow'), 'monitor live updates stream should include workflow events');
    assert(monitorLiveUpdates.text.includes('"monitorState"'), 'monitor live updates workflow event should include monitorState');
    assert(monitorLiveUpdates.text.includes('planner-agent'), 'monitor live updates should include planner-agent lease owner');
    assert(monitorLiveUpdates.text.includes('reviewer-agent'), 'monitor live updates should include reviewer-agent lease owner');

    const [scopedLiveUpdates, workflowOnlyLiveUpdates] = await Promise.all([
      request({
        port,
        method: 'GET',
        pathname: buildAdminApiPath.liveUpdates({
          chainId: reassignFixture.chain.chainId,
          workflowId,
          limit: 10
        })
      }),
      request({
        port,
        method: 'GET',
        pathname: buildAdminApiPath.liveUpdates({
          workflowId: monitorWorkflowId,
          limit: 10
        })
      })
    ]);
    assert(scopedLiveUpdates.statusCode === 200, 'first concurrent live updates stream should return 200');
    assert(workflowOnlyLiveUpdates.statusCode === 200, 'second concurrent live updates stream should return 200');
    assert(String(scopedLiveUpdates.headers['content-type'] || '').includes('text/event-stream'), 'first concurrent live updates stream should return an event stream');
    assert(String(workflowOnlyLiveUpdates.headers['content-type'] || '').includes('text/event-stream'), 'second concurrent live updates stream should return an event stream');
    assert(scopedLiveUpdates.text.includes('event: heartbeat'), 'first concurrent live updates stream should include heartbeat events');
    assert(workflowOnlyLiveUpdates.text.includes('event: heartbeat'), 'second concurrent live updates stream should include heartbeat events');
    assert(scopedLiveUpdates.text.includes(`"workflowId":"${workflowId}"`), 'first concurrent live updates stream should keep its workflow scope');
    assert(workflowOnlyLiveUpdates.text.includes(`"workflowId":"${monitorWorkflowId}"`), 'second concurrent live updates stream should keep its workflow scope');
    assert(workflowOnlyLiveUpdates.text.includes('planner-agent'), 'second concurrent live updates stream should keep monitor worker data');
    assert(workflowOnlyLiveUpdates.text.includes('reviewer-agent'), 'second concurrent live updates stream should keep monitor worker data');

    assert(rerunChainState.statusCode === 200, 'rerun chain state endpoint should return 200');
    assert(rerunChainState.json.chainState?.reruns?.length >= 1, 'rerun chain state should expose chain rerun records');
    assert(rerunChainState.json.chainState?.runLogs?.some((log) => log.action === 'chain_rerun_created' || log.action === 'chain_stage_rerun_requested'), 'rerun chain state should expose rerun run logs');
    assert(rerunChainState.json.chainState?.stageRevisions?.some((revision) => revision.rerunId), 'rerun chain state should expose stage revisions linked to reruns');
    const rerunWorkflowStateFromChain = (rerunChainState.json.chainState?.workflowStates || []).find((state) => state.workflow?.workflowId === rerunStage.workflowId);
    assert(rerunWorkflowStateFromChain, 'rerun chain state should aggregate the rerun stage workflow state');
    assert(Array.isArray(rerunWorkflowStateFromChain.dependencies) && rerunWorkflowStateFromChain.dependencies.length >= 2, 'rerun workflow state from chain aggregation should preserve workflow dependencies');

    const rerunWorkflowState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.workflow(rerunStage.workflowId, {
        includeRunLogs: true,
        includeReruns: true,
        includeRevisions: true,
        includeOutputs: true,
        limit: 50
      })
    });
    assert(rerunWorkflowState.statusCode === 200, 'rerun workflow state endpoint should return 200');
    assert(rerunWorkflowState.json.workflowState?.workflow?.workflowId === rerunStage.workflowId, 'rerun workflow state endpoint should expose the rerun workflow');
    assert(rerunWorkflowState.json.workflowState?.dependencies?.length >= 2, 'rerun workflow state should expose plan dependencies');
    assert(rerunWorkflowState.json.workflowState?.reruns?.length >= 1, 'rerun workflow state should expose workflow rerun records');
    assert(rerunWorkflowState.json.workflowState?.taskRevisions?.some((revision) => revision.rerunId), 'rerun workflow state should expose task revisions linked to reruns');
    assert(rerunWorkflowState.json.workflowState?.runLogs?.some((log) => log.action === 'workflow_rerun_created' || log.action === 'task_rerun_requested'), 'rerun workflow state should expose workflow rerun run logs');

    const currentOnlyState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.coordinatorState({
        chainId: resumeFixture.chain.chainId,
        includeTestData: true,
        includeHistory: false,
        assignmentLimit: 50,
        handoffLimit: 50
      })
    });
    assert(currentOnlyState.statusCode === 200, 'current-only coordinator state should return 200');
    assert(currentOnlyState.json.assignments.every((assignment) => assignment.historyKind !== 'history'), 'current-only coordinator state should hide history assignments');
    assert(currentOnlyState.json.handoffs.every((handoff) => handoff.historyKind !== 'history'), 'current-only coordinator state should hide history handoffs');
    assert(currentOnlyState.json.summary?.historyAssignmentCount >= 1, 'current-only coordinator state should summarize hidden assignment history');
    assert(typeof currentOnlyState.json.summary?.historyHandoffCount === 'number', 'current-only coordinator state should summarize handoff history');

    const filteredState = await requestJson({
      port,
      method: 'GET',
      pathname: buildAdminApiPath.coordinatorState({
        chainId: resumeFixture.chain.chainId,
        includeTestData: true,
        includeHistory: true,
        assignmentLimit: 50,
        handoffLimit: 50
      })
    });
    assert(filteredState.statusCode === 200, 'filtered coordinator state should return 200');
    assert(filteredState.json.status === 'ok', 'filtered coordinator state should return ok status');
    assert(filteredState.json.chainState?.chain?.status === 'done', 'resume fixture should finish through the admin API');
    assert(filteredState.json.assignments.some((assignment) => assignment.status === 'blocked' && assignment.historyKind === 'history'), 'filtered coordinator state should preserve blocked assignment history');
    assert(filteredState.json.assignments.every((assignment) => assignment.historyKind), 'filtered coordinator state should classify assignment history');
    assert(filteredState.json.handoffs.every((handoff) => handoff.historyKind), 'filtered coordinator state should classify handoff history');
    assert(filteredState.json.handoffs.length >= 2, 'filtered coordinator state should expose persisted handoffs');

    console.log('admin ui smoke test passed');
    console.log(JSON.stringify({
      port,
      agentCount: initialState.json.summary.agentCount,
      resumeChainId: resumeFixture.chain.chainId,
      reassignChainId: reassignFixture.chain.chainId,
      rerunChainId: rerunFixture.chain.chainId,
      resumeAssignmentCount: filteredState.json.assignments.length,
      reassignStageCount: chainState.json.chainState.stages.length,
      reassignWorkflowOutputCount: workflowState.json.workflowState.taskOutputs.length,
      rerunWorkflowDependencyCount: rerunWorkflowState.json.workflowState.dependencies.length,
      rerunChainRerunCount: rerunChainState.json.chainState.reruns.length
    }, null, 2));
  } finally {
    if (adminServer) {
      await adminServer.close().catch(() => {});
    }
    closeDb();
    await fs.rm(`${dbPath}.lock`, { force: true });
  }
}

function request({ port, method, pathname, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      hostname: ADMIN_SERVER_DEFAULT_HOST,
      port,
      method,
      path: pathname,
      headers: payload
        ? {
            'content-type': 'application/json',
            'content-length': String(payload.length)
          }
        : undefined
    }, (response) => {
      const chunks = [];
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        const contentType = String(response.headers['content-type'] || '');
        let json = null;
        if (contentType.includes('application/json') && text.trim()) {
          json = JSON.parse(text);
        }
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          text,
          json
        });
      };
      response.on('data', (chunk) => {
        chunks.push(chunk);
        if (String(response.headers['content-type'] || '').includes('text/event-stream') && Buffer.concat(chunks).toString('utf8').includes('event: heartbeat')) {
          req.destroy();
          response.destroy();
          finish();
        }
      });
      response.on('end', finish);
      response.on('close', finish);
    });

    req.on('error', (error) => {
      if (String(error?.message || '').includes('socket hang up')) {
        return;
      }
      reject(error);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function requestJson(options) {
  const response = await request(options);
  assert(response.json && typeof response.json === 'object', `${options.method} ${options.pathname} should return JSON`);
  return response;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
