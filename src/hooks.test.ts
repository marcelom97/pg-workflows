import type { PgBoss } from 'pg-boss';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('Lifecycle Hooks', () => {
  it('should call onStart on first execution', async () => {
    const onStart = vi.fn();

    const wf = workflow(
      'hooks-onstart',
      async ({ step }) => {
        return await step.run('s1', async () => 'done');
      },
      { onStart },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'hooks-onstart',
      input: { foo: 'bar' },
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

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'hooks-onstart',
        runId: run.id,
        input: { foo: 'bar' },
      }),
    );

    await engine.stop();
  }, 30000);

  it('should call onSuccess and onComplete on successful completion', async () => {
    const onSuccess = vi.fn();
    const onComplete = vi.fn();

    const wf = workflow(
      'hooks-success',
      async ({ step }) => {
        return await step.run('s1', async () => 'result-value');
      },
      { onSuccess, onComplete },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'hooks-success',
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

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'hooks-success',
        runId: run.id,
        output: 'result-value',
      }),
    );

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { ok: true, output: 'result-value' },
      }),
    );

    await engine.stop();
  }, 30000);

  it('should call onFailure and onComplete on failure after retries exhausted', async () => {
    const onFailure = vi.fn();
    const onComplete = vi.fn();

    const wf = workflow(
      'hooks-failure',
      async ({ step }) => {
        return await step.run('s1', async () => {
          throw new Error('boom');
        });
      },
      { retries: 0, onFailure, onComplete },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'hooks-failure',
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
      .toBe(WorkflowStatus.FAILED);

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'hooks-failure',
        runId: run.id,
        error: expect.stringContaining('boom'),
      }),
    );

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { ok: false, error: expect.stringContaining('boom') },
      }),
    );

    await engine.stop();
  }, 30000);

  it('should not let hook errors affect workflow status', async () => {
    const onSuccess = vi.fn().mockRejectedValue(new Error('hook error'));

    const wf = workflow(
      'hooks-safe',
      async ({ step }) => {
        return await step.run('s1', async () => 'ok');
      },
      { onSuccess },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'hooks-safe',
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

    expect(onSuccess).toHaveBeenCalledOnce();

    await engine.stop();
  }, 30000);

  it('should call onCancel when workflow is cancelled', async () => {
    const onCancel = vi.fn();

    const wf = workflow(
      'hooks-cancel',
      async ({ step }) => {
        await step.pause('wait-here');
        return 'done';
      },
      { onCancel },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'hooks-cancel',
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
      .toBe(WorkflowStatus.PAUSED);

    await engine.cancelWorkflow({ runId: run.id });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'hooks-cancel',
        runId: run.id,
      }),
    );

    await engine.stop();
  }, 30000);
});
