export class WorkflowEngineError extends Error {
  constructor(
    message: string,
    public readonly workflowId?: string,
    public readonly runId?: string,
    public override readonly cause: Error | undefined = undefined,
  ) {
    super(message);
    this.name = 'WorkflowEngineError';

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, WorkflowEngineError);
    }
  }
}

export class WorkflowRunNotFoundError extends WorkflowEngineError {
  constructor(runId?: string, workflowId?: string) {
    super('Workflow run not found', workflowId, runId);
    this.name = 'WorkflowRunNotFoundError';
  }
}
