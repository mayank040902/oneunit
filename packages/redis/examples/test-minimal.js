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
  },
  silentLogger,
);

const healthResult = await health(redis);
if (healthResult.status === "down") {
  console.log("Redis is not reachable, stopping here.");
  console.log("Health:", healthResult);
  await shutdown(redis, silentLogger);
  process.exit(0);
}
