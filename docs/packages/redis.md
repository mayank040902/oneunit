# @oneunit/redis

Redis client and BullMQ job queues. Works standalone or with any logger that has `error`, `warn`, `info`, and `debug`.

Package README: `packages/redis/README.md` ·
Architecture: `packages/redis/ARCHITECTURE.md`

## Install

```bash
npm install @oneunit/redis
```

## API

| Export                              | Description                                            |
| :---------------------------------- | :----------------------------------------------------- |
| `createClient(options?, logger?)`   | ioredis client with event logging                      |
| `createClient(url, logger?)`        | same, taking a URL string like `new Redis(url)`        |
| `shutdown(client, logger?)`         | Graceful `quit()`, safe to call more than once         |
| `health(client, options?)`          | Ping-based health result, bounded by `options.timeout` |
| `createQueue(config)`               | BullMQ queue                                           |
| `createWorker(config)`              | BullMQ worker                                          |
| `attachQueueEvents(config)`         | BullMQ queue event listener                            |
| `runPipeline(client, steps, opts?)` | Batch commands into one round trip                     |
| `pipelineValues(results)`           | Ordered values of a fully successful batch             |
| `attachEvents(client, logger?)`     | Log ioredis events; `createClient` already calls this  |
| `createLogger(input?)`              | Wrap any logger, completing missing levels             |
| `isLogger(value)`                   | Whether a value looks like a `Logger`                  |
| `redactError(error)`                | Strip credential-bearing commands from an error        |
| `consoleLogger` / `silentLogger`    | Built-in logger adapters                               |

`logger` is optional on every export. A partial logger is completed rather than
rejected, so a missing level cannot throw from inside a connection event.

pino is detected from the `bindings()` method and `levels` map it carries and
gets its `(bindings, message)` argument order. Every other logger, including
one with `child()`, gets `(message, extra)`. See the package README.

## Credentials

ioredis attaches the failing command to its errors, and for `AUTH` those args are
the password in plaintext. Every error path in this package runs
`redactError(error)` before logging, so a wrong-password server does not write
the credential to your log on every reconnect attempt. Use `redactError` on any
ioredis error you handle yourself.

## Defaults

`createClient`: `url` from `REDIS_URL`, `lazyConnect: true`, and
`maxRetriesPerRequest: null`. That last one is not incidental — BullMQ rejects
any connection where it is set, and the queue factories are designed to take
this same client instance.

`health`: `timeout` of 1000ms. ioredis queues commands while reconnecting, so a
`PING` against an unreachable server never settles; without the bound a health
endpoint hangs instead of reporting `down`.

`createQueue`: prefix `queue`, 3 attempts, exponential backoff 1000ms, keep last
100 completed and 1000 failed jobs. An explicit `undefined` in
`defaultJobOptions` falls back to these rather than clearing them; `null` is
passed through, since BullMQ reads `removeOnComplete: null` as "keep forever".

`createWorker`: prefix `queue`, and BullMQ's default concurrency of 1.

`runPipeline`: `timeout` of 5000ms. Same reason as `health` — ioredis parks
queued commands while reconnecting, so a pipeline `exec()` against an unreachable
server never settles.

## Pipelines

A command that fails inside a pipeline does not fail the pipeline. ioredis
resolves `exec()` and reports the failure per command, so reading only the values
gives `null` for a write that never landed, with nothing to tell it apart from a
successful one. `runPipeline` returns one labelled result per command with an
explicit `error`, and bounds the batch with a timeout.

```javascript
import { runPipeline, pipelineValues } from "@oneunit/redis/pipeline";

const result = await runPipeline(client, [
  { label: "set:a", run: (p) => void p.set("a", "1") },
  { label: "get:a", run: (p) => void p.get("a") },
]);

result.failed; // 0
pipelineValues(result.results); // ["OK", "1"], throws if anything failed
```

Pipeline errors are redacted before the results are returned, so the result
array is safe to log as a whole. Use it for commands you already have in hand;
a pipeline does not help when each command depends on the previous one's result.

## Prefix

`prefix` is set per call on `createQueue`, `createWorker`, and
`attachQueueEvents`. Use the same value on all three. `attachQueueEvents`
inherits the queue's prefix when you do not pass one, so in practice you only
need to set it on the queue and worker.

## Subpath imports

```javascript
import { createClient } from "@oneunit/redis/client";
import { createQueue, createWorker } from "@oneunit/redis/queue";
import { runPipeline } from "@oneunit/redis/pipeline";
```
