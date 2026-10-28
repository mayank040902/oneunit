import {
  createClient,
  health,
  shutdown,
  silentLogger,
  createQueue,
  attachQueueEvents,
  closeQueue,
} from "@oneunit/redis";

const REDIS_URL = "redis://127.0.0.1:6399";

const redis = createClient(
  {
    url: REDIS_URL,
  },
  silentLogger,
);

const healthResult = await health(redis);
if (healthResult.status === "down") {
  console.log("Redis is not reachable, stopping here.");
  console.log("Health:", healthResult);
  
  console.log("Creating queue...");
  const queue = createQueue({
    name: "efficient-jobs",
    connection: redis,
    prefix: "queue",
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
      removeOnComplete: 100,
      removeOnFail: 1000,
    },
  });
  
  console.log("Creating queue events...");
  const events = attachQueueEvents({
    queue,
    logger: silentLogger,
    prefix: "queue",
    connection: redis,
  });
  
  console.log("Closing events...");
  const closeEventsPromise = events.close();
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error("events.close() timed out")), 5000)
  );
  
  try {
    await Promise.race([closeEventsPromise, timeoutPromise]);
    console.log("events.close() completed");
  } catch (e) {
    console.error("events.close() failed:", e.message);
  }
  
  console.log("Closing queue...");
  const closeQueuePromise = closeQueue(queue);
  const timeoutPromise2 = new Promise((_, reject) => 
    setTimeout(() => reject(new Error("closeQueue() timed out")), 5000)
  );
  
  try {
    await Promise.race([closeQueuePromise, timeoutPromise2]);
    console.log("closeQueue() completed");
  } catch (e) {
    console.error("closeQueue() failed:", e.message);
  }
  
  console.log("Shutting down redis...");
  await shutdown(redis, silentLogger);
  console.log("Done");
  process.exit(0);
}
