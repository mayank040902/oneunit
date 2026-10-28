import { test } from "vitest";
import assert from "node:assert/strict";
import { createClient, createBurstProtector, shutdown, silentLogger } from "../../dist/index.js";

const URL="redis://127.0.0.1:6379/9";
test("burst protection", async () => {
  const c=createClient({url:URL},silentLogger);
  try {
    await c.flushdb();
    const bp=createBurstProtector(c,{sustainedLimit:10,sustainedIntervalMs:10000,burstCapacity:3,burstIntervalMs:1000});
    const r1=await bp.consume("u",1);
    const r2=await bp.consume("u",1);
    const r3=await bp.consume("u",1);
    const r4=await bp.consume("u",1);
    assert.equal(r1.allowed,true);
    assert.equal(r2.allowed,true);
    assert.equal(r3.allowed,true);
    assert.equal(r4.allowed,false);
    assert.equal(r4.reason,"burst_limit");
  } finally { await c.flushdb().catch(()=>{}); await shutdown(c,silentLogger); }
});
