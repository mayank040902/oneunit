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
  
  console.log("Closing jobAtLeastOnce...");
  const closePromise = redis.jobAtLeastOnce.close();
  
  // Add a timeout to see if it hangs
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error("close() timed out")), 5000)
  );
  
  try {
    await Promise.race([closePromise, timeoutPromise]);
    console.log("jobAtLeastOnce.close() completed");
  } catch (e) {
    console.error("jobAtLeastOnce.close() failed:", e.message);
  }
  
  console.log("Shutting down redis...");
  await shutdown(redis, silentLogger);
  console.log("Done");
  process.exit(0);
}
