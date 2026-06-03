export default async function simpleJsAdapter(input) {
  return {
    status: 'done',
    doneSummary: `完成任务：${input.task?.title || 'unknown-task'}`,
    payload: {
      adapter: 'simple-js',
      taskId: input.task?.taskId || null
    },
    handoff: {
      summary: 'simple-js adapter 已完成任务。',
      artifacts: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      recommendedNextRole: null
    }
  };
}
