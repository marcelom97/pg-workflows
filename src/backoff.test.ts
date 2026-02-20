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

describe('Configurable Backoff', () => {
  it('should use default backoff when only retries is set', async () => {
    let attempts = 0;

    const wf = workflow(
      'backoff-default',
      async ({ step }) => {
        const result = await step.run('fail-step', async () => {
          attempts++;
          if (attempts < 3) throw new Error('fail');
          return 'done';
        });
        return result;
      },
      { retries: 3 },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'backoff-default',
      input: {},
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 15000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    await engine.stop();
  });

  it('should use custom retry config when retry option is set', async () => {
    let attempts = 0;

    const wf = workflow(
      'backoff-custom',
      async ({ step }) => {
        const result = await step.run('fail-step', async () => {
          attempts++;
          if (attempts < 2) throw new Error('fail');
          return 'done';
        });
        return result;
      },
      {
        retry: {
          maxAttempts: 3,
          backoff: {
            factor: 2,
            minDelay: 500,
            maxDelay: 5000,
            jitter: false,
          },
        },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'backoff-custom',
      input: {},
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 15000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    await engine.stop();
  });

  it('retry config should take precedence over retries option', async () => {
    let attempts = 0;

    const wf = workflow(
      'backoff-precedence',
      async ({ step }) => {
        const result = await step.run('fail-step', async () => {
          attempts++;
          if (attempts < 3) throw new Error('fail');
          return 'done';
        });
        return result;
      },
      {
        retries: 1,
        retry: { maxAttempts: 5 },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'backoff-precedence',
      input: {},
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 15000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    await engine.stop();
  });
});
