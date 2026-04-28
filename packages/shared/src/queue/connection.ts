import { Queue, QueueEvents, Worker, type ConnectionOptions } from "bullmq";
import type { Processor } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "../env.js";

let _redis: Redis | undefined;

export function getRedisConnection(): Redis {
  if (_redis) return _redis;
  const env = loadEnv();
  _redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return _redis;
}

export function getBullConnection(): ConnectionOptions {
  return getRedisConnection();
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = undefined;
  }
}

export const QUEUE_NAMES = {
  scan: "scan-wallet",
  mintConfirm: "mint-confirm",
  webhook: "helius-webhook",
  checkBalance: "check-balance",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function createQueue<T = unknown>(name: QueueName): Queue<T> {
  return new Queue<T>(name, { connection: getBullConnection() });
}

export function createWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Processor<T, R>,
  concurrency = 1,
): Worker<T, R> {
  return new Worker<T, R>(name, processor, {
    connection: getBullConnection(),
    concurrency,
  });
}

export function createQueueEvents(name: QueueName): QueueEvents {
  return new QueueEvents(name, { connection: getBullConnection() });
}
