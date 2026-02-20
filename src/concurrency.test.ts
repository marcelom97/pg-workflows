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

  it('should enforce serial execution with concurrency limit of 1', async () => {
    let activeCount = 0;
    let maxActive = 0;

    const wf = workflow(
      'conc-serial',
      async ({ step }) => {
        return await step.run('s1', async () => {
          activeCount++;
          maxActive = Math.max(maxActive, activeCount);
          await new Promise((r) => setTimeout(r, 300));
          activeCount--;
          return 'done';
        });
      },
      {
        concurrency: { limit: 1 },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const runs = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        engine.startWorkflow({
          workflowId: 'conc-serial',
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

    expect(maxActive).toBe(1);

    await engine.stop();
  }, 30000);

  it('should route retries through the dedicated queue', async () => {
    let attempts = 0;

    const wf = workflow(
      'conc-retry',
      async ({ step }) => {
        return await step.run('s1', async () => {
          attempts++;
          if (attempts < 3) throw new Error('fail');
          return 'done';
        });
      },
      {
        retries: 3,
        concurrency: { limit: 1 },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'conc-retry',
      input: {},
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 20000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    expect(attempts).toBe(3);

    await engine.stop();
  }, 30000);

  it('should set up dedicated queue when registering workflow after engine start', async () => {
    let activeCount = 0;
    let maxActive = 0;

    const engine = new WorkflowEngine({ boss: testBoss });
    await engine.start();

    const wf = workflow(
      'conc-post-start',
      async ({ step }) => {
        return await step.run('s1', async () => {
          activeCount++;
          maxActive = Math.max(maxActive, activeCount);
          await new Promise((r) => setTimeout(r, 400));
          activeCount--;
          return 'done';
        });
      },
      {
        concurrency: { limit: 1 },
      },
    );

    await engine.registerWorkflow(wf);

    const runs = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        engine.startWorkflow({
          workflowId: 'conc-post-start',
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

    expect(maxActive).toBe(1);

    await engine.stop();
  }, 30000);

  it('should handle mixed limited and unlimited workflows independently', async () => {
    let limitedActive = 0;
    let limitedMax = 0;

    const limitedWf = workflow(
      'conc-mixed-limited',
      async ({ step }) => {
        return await step.run('s1', async () => {
          limitedActive++;
          limitedMax = Math.max(limitedMax, limitedActive);
          await new Promise((r) => setTimeout(r, 400));
          limitedActive--;
          return 'limited-done';
        });
      },
      {
        concurrency: { limit: 1 },
      },
    );

    const unlimitedWf = workflow('conc-mixed-unlimited', async ({ step }) => {
      return await step.run('s1', async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'unlimited-done';
      });
    });

    const engine = new WorkflowEngine({
      boss: testBoss,
      workflows: [limitedWf, unlimitedWf],
    });
    await engine.start();

    const limitedRuns = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        engine.startWorkflow({
          workflowId: 'conc-mixed-limited',
          input: { i },
        }),
      ),
    );

    const unlimitedRuns = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        engine.startWorkflow({
          workflowId: 'conc-mixed-unlimited',
          input: { i },
        }),
      ),
    );

    for (const run of [...limitedRuns, ...unlimitedRuns]) {
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

    expect(limitedMax).toBe(1);

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
