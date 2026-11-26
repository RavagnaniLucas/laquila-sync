import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const syncQueue = new Queue('sync', { connection });
export const ordersQueue = new Queue('orders', {
  connection,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
});

/** Enfileira o avanço de um pedido (um job por pedido por vez). */
export function enqueueOrder(id: string, delayMs = 0) {
  return ordersQueue.add('advance', { id }, { jobId: `advance-${id.split('/').pop()}-${Date.now()}`, delay: delayMs });
}
