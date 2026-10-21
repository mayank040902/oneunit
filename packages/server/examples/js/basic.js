async function main() {
  const { startServer } = await import("@oneunit/server");
  const { address, close } = await startServer({
    serviceName: "api",
    logger: false,
    env: false,
    database: false,
    kafka: false,
    redis: false,
    realtime: false,
    health: false,
    port: 0,
    gracefulShutdown: false,
  });
  console.log(`listening at ${address}`);
  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
