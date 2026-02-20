import type { PgBoss } from 'pg-boss';
import { beforeAll, describe, expect, it } from 'vitest';
import { workflow } from './definition';
import { WorkflowEngine } from './engine';
import { getBoss } from './tests/pgboss';
import { createTestDatabase } from './tests/test-db';
import { WorkflowStatus } from './types';

let testBoss: PgBoss;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  testBoss = await getBoss(testDb);
});

describe('Concurrency Limits', () => {
  it('should enforce concurrency limit on a workflow', async () => {
    let activeCount = 0;
    let maxActive = 0;

    const wf = workflow(
      'conc-limit',
      async ({ step }) => {
        return await step.run('s1', async () => {
          activeCount++;
          maxActive = Math.max(maxActive, activeCount);
          await new Promise((r) => setTimeout(r, 500));
          activeCount--;
          return 'done';
        });
      },
      {
        concurrency: { limit: 2 },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const runs = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        engine.startWorkflow({
          workflowId: 'conc-limit',
          input: { i },
        }),
      ),
    );

    for (const run of runs) {
      await expect
        .poll(
          async () => {
            const r = await engine.getRun({ runId: run.id });
            return r.status;
          },
          { timeout: 20000 },
        )
        .toBe(WorkflowStatus.COMPLETED);
    }

    expect(maxActive).toBeLessThanOrEqual(2);

    await engine.stop();
  }, 30000);

  it('should not limit concurrency when concurrency option is not set', async () => {
    const wf = workflow('conc-unlimited', async ({ step }) => {
      return await step.run('s1', async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'done';
      });
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const runs = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        engine.startWorkflow({
          workflowId: 'conc-unlimited',
          input: { i },
        }),
      ),
    );

    for (const run of runs) {
      await expect
        .poll(
          async () => {
            const r = await engine.getRun({ runId: run.id });
            return r.status;
          },
          { timeout: 15000 },
        )
        .toBe(WorkflowStatus.COMPLETED);
    }

    await engine.stop();
  }, 30000);
});
