import IORedis from "ioredis";

let connection: IORedis | undefined;

/**
 * Shared across the Queue (producer, inside Next's process) and the Worker
 * (consumer, a separate process) — both need `maxRetriesPerRequest: null`,
 * which BullMQ requires for its blocking connections.
 */

//connect to the redis connection via REDIS_URl 

export function getRedisConnection(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("Missing REDIS_URL environment variable");
    }
    connection = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return connection;
}
