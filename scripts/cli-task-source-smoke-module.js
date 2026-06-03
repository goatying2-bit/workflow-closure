export default {
  async load() {
    return {
      workflowId: 'cli-task-source-workflow',
      instruction: '通过 CLI task source module 创建 workflow',
      goal: '通过 CLI task source module 创建 workflow',
      plan: {
        goal: '通过 CLI task source module 创建 workflow',
        steps: [
          {
            key: 'collect',
            title: '收集 task source 输入',
            description: '从 task source module 返回 workflow 定义。'
          },
          {
            key: 'apply',
            title: '落地 workflow',
            description: '把 task source 结果转换为 workflow 状态。'
          }
        ],
        dependencies: [
          { from: 'collect', to: 'apply' }
        ]
      },
      metadata: {
        taskSource: 'cli-task-source-module'
      }
    };
  }
};
