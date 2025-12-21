import type {
  Parameters,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowOptions,
  inferParameters,
} from './types';

export function workflow<I extends Parameters>(
  id: string,
  handler: (context: WorkflowContext<inferParameters<I>>) => Promise<unknown>,
  { inputSchema, timeout, retries }: WorkflowOptions<I> = {},
): WorkflowDefinition<I> {
  return {
    id,
    handler,
    inputSchema,
    timeout,
    retries,
  };
}
