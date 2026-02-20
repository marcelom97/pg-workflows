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

describe('Idempotency Keys', () => {
  it('should return existing active run when same idempotency key is used', async () => {
    const wf = workflow('idemp-basic', async ({ step }) => {
      await step.pause('wait');
      return 'done';
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run1 = await engine.startWorkflow({
      workflowId: 'idemp-basic',
      input: { a: 1 },
      idempotencyKey: 'key-1',
    });

    const run2 = await engine.startWorkflow({
      workflowId: 'idemp-basic',
      input: { a: 2 },
      idempotencyKey: 'key-1',
    });

    expect(run1.id).toBe(run2.id);

    await engine.stop();
  }, 30000);

  it('should create new run when no idempotency key is provided', async () => {
    const wf = workflow('idemp-nokey', async ({ step }) => {
      await step.pause('wait');
      return 'done';
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run1 = await engine.startWorkflow({
      workflowId: 'idemp-nokey',
      input: {},
    });

    const run2 = await engine.startWorkflow({
      workflowId: 'idemp-nokey',
      input: {},
    });

    expect(run1.id).not.toBe(run2.id);

    await engine.stop();
  }, 30000);

  it('should allow new run after previous one with same key completed', async () => {
    const wf = workflow('idemp-reuse', async ({ step }) => {
      return await step.run('s1', async () => 'done');
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run1 = await engine.startWorkflow({
      workflowId: 'idemp-reuse',
      input: {},
      idempotencyKey: 'reuse-key',
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run1.id });
          return r.status;
        },
        { timeout: 10000 },
      )
      .toBe(WorkflowStatus.COMPLETED);

    const run2 = await engine.startWorkflow({
      workflowId: 'idemp-reuse',
      input: {},
      idempotencyKey: 'reuse-key',
    });

    expect(run2.id).not.toBe(run1.id);

    await engine.stop();
  }, 30000);

  it('should allow new run after previous one with same key failed', async () => {
    const wf = workflow(
      'idemp-fail',
      async ({ step }) => {
        return await step.run('s1', async () => {
          throw new Error('boom');
        });
      },
      { retries: 0 },
    );

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run1 = await engine.startWorkflow({
      workflowId: 'idemp-fail',
      input: {},
      idempotencyKey: 'fail-key',
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run1.id });
          return r.status;
        },
        { timeout: 10000 },
      )
      .toBe(WorkflowStatus.FAILED);

    const run2 = await engine.startWorkflow({
      workflowId: 'idemp-fail',
      input: {},
      idempotencyKey: 'fail-key',
    });

    expect(run2.id).not.toBe(run1.id);

    await engine.stop();
  }, 30000);

  it('should allow new run after previous one with same key was cancelled', async () => {
    const wf = workflow('idemp-cancel', async ({ step }) => {
      await step.pause('wait');
      return 'done';
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run1 = await engine.startWorkflow({
      workflowId: 'idemp-cancel',
      input: {},
      idempotencyKey: 'cancel-key',
    });

    await expect
      .poll(
        async () => {
          const r = await engine.getRun({ runId: run1.id });
          return r.status;
        },
        { timeout: 10000 },
      )
      .toBe(WorkflowStatus.PAUSED);

    await engine.cancelWorkflow({ runId: run1.id });

    const run2 = await engine.startWorkflow({
      workflowId: 'idemp-cancel',
      input: {},
      idempotencyKey: 'cancel-key',
    });

    expect(run2.id).not.toBe(run1.id);

    await engine.stop();
  }, 30000);

  it('should store idempotency key on the run', async () => {
    const wf = workflow('idemp-stored', async ({ step }) => {
      await step.pause('wait');
      return 'done';
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run = await engine.startWorkflow({
      workflowId: 'idemp-stored',
      input: {},
      idempotencyKey: 'my-key',
    });

    const fetched = await engine.getRun({ runId: run.id });
    expect(fetched.idempotencyKey).toBe('my-key');

    await engine.stop();
  }, 30000);

  it('should create separate runs for different keys on same workflow', async () => {
    const wf = workflow('idemp-diff-keys', async ({ step }) => {
      await step.pause('wait');
      return 'done';
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf] });
    await engine.start();

    const run1 = await engine.startWorkflow({
      workflowId: 'idemp-diff-keys',
      input: {},
      idempotencyKey: 'key-alpha',
    });

    const run2 = await engine.startWorkflow({
      workflowId: 'idemp-diff-keys',
      input: {},
      idempotencyKey: 'key-beta',
    });

    expect(run1.id).not.toBe(run2.id);

    await engine.stop();
  }, 30000);

  it('should scope idempotency to workflow ID', async () => {
    const wf1 = workflow('idemp-scope-a', async ({ step }) => {
      await step.pause('wait');
      return 'done';
    });
    const wf2 = workflow('idemp-scope-b', async ({ step }) => {
      await step.pause('wait');
      return 'done';
    });

    const engine = new WorkflowEngine({ boss: testBoss, workflows: [wf1, wf2] });
    await engine.start();

    const run1 = await engine.startWorkflow({
      workflowId: 'idemp-scope-a',
      input: {},
      idempotencyKey: 'shared-key',
    });

    const run2 = await engine.startWorkflow({
      workflowId: 'idemp-scope-b',
      input: {},
      idempotencyKey: 'shared-key',
    });

    expect(run1.id).not.toBe(run2.id);

    await engine.stop();
  }, 30000);
});
