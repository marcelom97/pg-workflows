import type { PgBoss } from 'pg-boss';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { workflow } from './definition';
import { WorkflowEngine } from './engine';
import { getBoss } from './tests/pgboss';
import { createTestDatabase } from './tests/test-db';
import { type Middleware, WorkflowStatus } from './types';

let testBoss: PgBoss;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  testBoss = await getBoss(testDb);
});

describe('Middleware System', () => {
  it('should run middleware around workflow execution', async () => {
    const order: string[] = [];

    const middleware: Middleware = async (_ctx, next) => {
      order.push('before');
      await next();
      order.push('after');
    };

    const wf = workflow('mw-basic', async ({ step }) => {
      const result = await step.run('s1', async () => {
        order.push('handler');
        return 'done';
      });
      return result;
    });

    const engine = new WorkflowEngine({
      boss: testBoss,
      workflows: [wf],
      middleware: [middleware],
    });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'mw-basic',
      input: {},
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 10000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    expect(order).toEqual(['before', 'handler', 'after']);

    await engine.stop();
  }, 30000);

  it('should compose multiple middleware in order', async () => {
    const order: string[] = [];

    const mw1: Middleware = async (_ctx, next) => {
      order.push('A-before');
      await next();
      order.push('A-after');
    };

    const mw2: Middleware = async (_ctx, next) => {
      order.push('B-before');
      await next();
      order.push('B-after');
    };

    const wf = workflow('mw-compose', async ({ step }) => {
      return await step.run('s1', async () => {
        order.push('handler');
        return 'done';
      });
    });

    const engine = new WorkflowEngine({
      boss: testBoss,
      workflows: [wf],
      middleware: [mw1, mw2],
    });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'mw-compose',
      input: {},
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 10000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    expect(order).toEqual(['A-before', 'B-before', 'handler', 'B-after', 'A-after']);

    await engine.stop();
  }, 30000);

  it('should support engine.use() to add middleware after construction', async () => {
    const called = vi.fn();

    const wf = workflow('mw-use', async ({ step }) => {
      return await step.run('s1', async () => 'done');
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    engine.use(async (ctx, next) => {
      called(ctx.workflowId);
      await next();
    });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'mw-use',
      input: {},
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 10000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    expect(called).toHaveBeenCalledWith('mw-use');

    await engine.stop();
  }, 30000);

  it('should provide correct context to middleware', async () => {
    let capturedCtx: Record<string, unknown> | null = null;

    const wf = workflow('mw-ctx', async ({ step }) => {
      return await step.run('s1', async () => 'done');
    });

    const engine = new WorkflowEngine({
      boss: testBoss,
      workflows: [wf],
      middleware: [
        async (ctx, next) => {
          capturedCtx = { workflowId: ctx.workflowId, runId: ctx.runId, input: ctx.input };
          await next();
        },
      ],
    });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'mw-ctx',
      input: { key: 'val' },
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run.id });
          return r.status;
        },
        { timeout: 10000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    expect(capturedCtx).toEqual(
      expect.objectContaining({
        workflowId: 'mw-ctx',
        runId: run.id,
        input: { key: 'val' },
      }),
    );

    await engine.stop();
  }, 30000);

  it('middleware errors should propagate and trigger retries', async () => {
    let callCount = 0;

    const wf = workflow(
      'mw-error',
      async ({ step }) => {
        return await step.run('s1', async () => 'done');
      },
      { retries: 1 },
    );

    const engine = new WorkflowEngine({
      boss: testBoss,
      workflows: [wf],
      middleware: [
        async (_ctx, next) => {
          callCount++;
          if (callCount === 1) throw new Error('middleware error');
          await next();
        },
      ],
    });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'mw-error',
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

    expect(callCount).toBe(2);

    await engine.stop();
  }, 30000);
});
