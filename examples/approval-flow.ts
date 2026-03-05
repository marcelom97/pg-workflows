import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { WorkflowEngine, type WorkflowRunProgress, workflow } from 'pg-workflows';

// 1. Define a workflow
const approvalWorkflow = workflow('approval-workflow', async ({ step, input }) => {
  const draft = await step.run('create-draft', async () => {
    console.log(`Creating draft for ${input.title}...`);
    return { id: 'draft_1', title: input.title, content: 'This is a draft document!' };
  });

  const approval = await step.waitFor('wait-approval', {
    eventName: 'approved',
    timeout: 60000,
  });

  await step.run('publish', async () => {
    console.log(`Publishing draft ${draft?.id} with approval:`, approval);
    return { published: true };
  });

  return { draftId: draft?.id, status: 'published', approvedBy: approval?.approved };
});

// 2. Start the engine
async function main() {
  const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/pg_workflows_example';

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
  });

  const engine = new WorkflowEngine({
    boss,
    workflows: [approvalWorkflow],
  });

  await engine.start();

  // 3. Run the workflow
  const run = await engine.startWorkflow({
    workflowId: 'approval-workflow',
    resourceId: 'tenant_1',
    input: { title: 'My Document' },
  });

  await new Promise((r) => setTimeout(r, 2000));

  await engine.triggerEvent({
    runId: run.id,
    resourceId: 'tenant_1',
    eventName: 'approved',
    data: { approvedBy: 'admin', approvedAt: new Date() },
  });

  // 4. Poll for completion
  let progress: WorkflowRunProgress;

  do {
    await new Promise((r) => setTimeout(r, 1000));
    progress = await engine.checkProgress({
      runId: run.id,
      resourceId: 'tenant_1',
    });
    console.log(
      `Progress: ${progress.completionPercentage}% (${progress.completedSteps}/${progress.totalSteps} steps)`,
    );
  } while (progress.status === 'running' || progress.status === 'paused');

  await engine.stop();
  await pool.end();
}

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
