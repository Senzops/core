import type { QueueSystem } from '../../../models/Queue';
import type { QueueAdapter } from './types';
import { bullmqAdapter } from './bullmq';
import { rabbitmqAdapter } from './rabbitmq';
import { kafkaAdapter } from './kafka';
import { sqsAdapter } from './sqs';

// Single source of truth mapping a queue system to its adapter implementation.
const REGISTRY: Record<QueueSystem, QueueAdapter> = {
  bullmq: bullmqAdapter,
  rabbitmq: rabbitmqAdapter,
  kafka: kafkaAdapter,
  sqs: sqsAdapter
};

export const getAdapter = (system: QueueSystem): QueueAdapter => {
  const adapter = REGISTRY[system];
  if (!adapter) throw new Error(`Unsupported queue system: ${system}`);
  return adapter;
};

/** Release pooled clients for a source across every adapter (used on delete). */
export const disposeAllAdapters = async (sourceId: string): Promise<void> => {
  await Promise.all(Object.values(REGISTRY).map(a => Promise.resolve(a.dispose(sourceId)).catch(() => {})));
};

export * from './types';
