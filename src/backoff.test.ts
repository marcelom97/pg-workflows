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
  }, 30000);

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
  }, 30000);

  it('should fail workflow when maxAttempts is exceeded', async () => {
    let attempts = 0;

    const wf = workflow(
      'backoff-exhaust',
      async ({ step }) => {
        const result = await step.run('always-fail', async () => {
          attempts++;
          throw new Error('permanent failure');
        });
        return result;
      },
      {
        retry: {
          maxAttempts: 2,
          backoff: { minDelay: 500, maxDelay: 2000, jitter: false },
        },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'backoff-exhaust',
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
      .toBe(WorkflowStatus.FAILED);

    expect(attempts).toBe(3); // 1 initial + 2 retries

    const finalRun = await engine.getRun({ runId: run.id });
    expect(finalRun.error).toContain('permanent failure');

    await engine.stop();
  }, 30000);

  it('should apply correct exponential delay between retries', async () => {
    const timestamps: number[] = [];

    const wf = workflow(
      'backoff-delay-check',
      async ({ step }) => {
        const result = await step.run('timed-fail', async () => {
          timestamps.push(Date.now());
          if (timestamps.length < 3) throw new Error('fail');
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
            maxDelay: 10000,
            jitter: false,
          },
        },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'backoff-delay-check',
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

    expect(timestamps.length).toBe(3);

    // First retry: factor^0 * minDelay = 2^0 * 500 = 500ms
    const delay1 = timestamps[1] - timestamps[0];
    expect(delay1).toBeGreaterThanOrEqual(400);
    expect(delay1).toBeLessThan(2000);

    // Second retry: factor^1 * minDelay = 2^1 * 500 = 1000ms
    const delay2 = timestamps[2] - timestamps[1];
    expect(delay2).toBeGreaterThanOrEqual(900);
    expect(delay2).toBeLessThan(3000);

    await engine.stop();
  }, 30000);

  it('should cap delay at maxDelay', async () => {
    const timestamps: number[] = [];

    const wf = workflow(
      'backoff-max-cap',
      async ({ step }) => {
        const result = await step.run('capped-fail', async () => {
          timestamps.push(Date.now());
          if (timestamps.length < 4) throw new Error('fail');
          return 'done';
        });
        return result;
      },
      {
        retry: {
          maxAttempts: 5,
          backoff: {
            factor: 10,
            minDelay: 500,
            maxDelay: 1500,
            jitter: false,
          },
        },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'backoff-max-cap',
      input: {},
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 25000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    expect(timestamps.length).toBe(4);

    // Third retry: factor^2 * minDelay = 10^2 * 500 = 50000, capped at 1500ms
    const delay3 = timestamps[3] - timestamps[2];
    expect(delay3).toBeGreaterThanOrEqual(1200);
    expect(delay3).toBeLessThan(3000); // should be ~1500, not ~50000

    await engine.stop();
  }, 30000);

  it('should apply jitter within expected bounds', async () => {
    const timestamps: number[] = [];

    const wf = workflow(
      'backoff-jitter',
      async ({ step }) => {
        const result = await step.run('jitter-fail', async () => {
          timestamps.push(Date.now());
          if (timestamps.length < 3) throw new Error('fail');
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
            maxDelay: 10000,
            jitter: true,
          },
        },
      },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'backoff-jitter',
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

    expect(timestamps.length).toBe(3);

    // First retry base: 2^0 * 500 = 500ms, jitter range: 375-625ms
    const delay1 = timestamps[1] - timestamps[0];
    expect(delay1).toBeGreaterThanOrEqual(250); // 375ms - scheduling slack
    expect(delay1).toBeLessThan(2000);

    // Second retry base: 2^1 * 500 = 1000ms, jitter range: 750-1250ms
    const delay2 = timestamps[2] - timestamps[1];
    expect(delay2).toBeGreaterThanOrEqual(600);
    expect(delay2).toBeLessThan(3000);

    await engine.stop();
  }, 30000);

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
  }, 30000);
});
