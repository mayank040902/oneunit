import {
  createClient,
  health,
  shutdown,
  silentLogger,
} from "@oneunit/redis";

const REDIS_URL = "redis://127.0.0.1:6399";

const redis = createClient(
  {
    url: REDIS_URL,
    jobAtLeastOnce: {
      enabled: true,
      queueName: "efficient-jobs",
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
      concurrency: 2,
      dlq: { queueName: "efficient-jobs", preservePayload: true, sanitizeFields: ["password", "token"] },
    },
  },
  silentLogger,
);

const healthResult = await health(redis);
if (healthResult.status === "down") {
  console.log("Redis is not reachable, stopping here.");
  console.log("Health:", healthResult);
  await redis.jobAtLeastOnce.close();
  await shutdown(redis, silentLogger);
  process.exit(0);
}
