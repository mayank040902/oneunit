import { createDatabase } from "./src/index.ts";

const db = createDatabase({
  connectionString: "postgresql://postgres@127.0.0.1:5440/shard0",
  sharding: {
    enabled: true,
    strategy: "hash",
    shards: [
      { id: "shard-0", connection: { connectionString: "postgresql://postgres@127.0.0.1:5440/shard0" } },
      { id: "shard-1", connection: { connectionString: "postgresql://postgres@127.0.0.1:5441/shard1" } },
    ],
  },
});

async function main() {
  const { Pool } = await import("pg");
  for (const uri of [
    "postgresql://postgres@127.0.0.1:5440/shard0",
    "postgresql://postgres@127.0.0.1:5441/shard1",
  ]) {
    const p = new Pool({ connectionString: uri });
    await p.query(`CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT, balance INT)`);
    await p.query(`TRUNCATE accounts`);
    await p.end();
  }

  const res = await db.sharding.distributedTransaction(async (tx) => {
    await tx.execute("k0", "INSERT INTO accounts (name,balance) VALUES ($1,$2)", ["A", 100]);
    await tx.execute("k1", "INSERT INTO accounts (name,balance) VALUES ($1,$2)", ["B", 200]);
  });
  console.log("TX RESULT", res);

  for (const uri of [
    "postgresql://postgres@127.0.0.1:5440/shard0",
    "postgresql://postgres@127.0.0.1:5441/shard1",
  ]) {
    const p = new Pool({ connectionString: uri });
    const r = await p.query("SELECT count(*)::int AS c FROM accounts");
    console.log(uri, r.rows[0]);
    await p.end();
  }
  await db.shutdown();
}

main().catch((e) => { console.error(e); process.exit(1); });
