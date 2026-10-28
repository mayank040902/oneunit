# Contributing to `@oneunit/redis`

Contributions are welcome — bug reports, tests, docs, and code. No CLA to sign
and no maintainer approval needed to open a pull request. The package is MIT
licensed, so your work stays yours.

Repository-wide conventions live in the [root CONTRIBUTING.md](../../CONTRIBUTING.md).
This file covers what is specific to a Redis client and queue library.

Before changing anything, read [ARCHITECTURE.md](./ARCHITECTURE.md). This
package is a thin layer over `ioredis` and `bullmq`, and most of the code here
exists to work around a specific sharp edge in one of them. Several of those
workarounds look like pointless indirection until you know which bug they
prevent.

## Reporting a security vulnerability

**Do not open a public issue or pull request for a security report.**

A connection helper has a wide blast radius: a flaw here reaches every
application that installs it, and a public write-up with details gives attackers
a head start while the fix is written. Report privately, in order of preference:

1. **GitHub Security Advisories** — the repository's _Security_ tab →
   _Report a vulnerability_. This opens a private thread only maintainers can
   see.
2. **Email** the maintainer at `04mayank09@gmail.com`.

Please include the affected version, a minimal reproduction, and the impact you
expect. You will get an acknowledgement, and you will be credited in the release
notes unless you would rather not be.

Everything else — a confusing error message, a missing test, an API that is
awkward to use — is a normal issue and welcome as one.

## Getting set up

Requires **Node.js 20+**. You can work directly inside `packages/redis` with **npm**, or across the monorepo using **pnpm 11.9.0** (`corepack enable` gets you the right pnpm).

### Working directly in `packages/redis` (standalone)

```bash
# Inside packages/redis
npm install
npm run build
npm test
```

### Working from the monorepo root

```bash
# From repository root
pnpm install
pnpm --filter @oneunit/redis build
pnpm --filter @oneunit/redis test
```

The build step is required before the tests, not optional: the suite imports
`dist`, which is gitignored and does not exist on a fresh checkout.

A **Redis on `localhost:6379`** makes the tests mean something. Without one they
still pass, but the queue, worker, pipeline, and performance cases no-op. Set
`REDIS_URL` to point somewhere else. Nothing in the suite hangs for want of a
server, but do not infer that from a green run with nothing listening.

The package typechecks, tests, and builds entirely on its own, so you do not
need the rest of the monorepo to work on it.

## The checks a pull request must pass

Run the full verification suite before submitting a pull request:

```bash
# Inside packages/redis:
npm run verify

# Or from monorepo root:
pnpm --filter @oneunit/redis verify
```

`npm run verify` runs the exact checks in order:

```bash
npm run build         # Clean dist/ and compile TypeScript
npm run typecheck     # Typecheck without emitting files
npm run lint          # ESLint across src/ and test/
npm test              # Run test suite with Vitest
npm run test:examples # Run example scripts smoke test
npm run pack:check    # Dry-run npm pack to catch packaging errors
```

CI runs these on **Node 20, 22, and 24** against a `redis` service container,
then installs the packed tarball into a clean project and exercises the public
API against it. That last step catches the failure mode unit tests miss: an
export that only resolves inside this repository.

Because CI always has a server, it cannot catch a test that quietly requires one.
The server-backed tests no-op when nothing is listening, so a run without Redis
is green while covering a good part of nothing — and one that was missing its
guard hung the suite outright rather than failing. **Start a Redis on
`localhost:6379` before trusting a local test run**, and see
[Tests that need Redis](#tests-that-need-redis).

**Build comes first, and the order is load-bearing.** `npm test` runs against
`dist`, not `src`: every test file imports `../dist/index.js`, and `dist/` is
gitignored, so a fresh checkout cannot load the suite at all until it is built.
Running `test` before `build` does not fail an assertion — it fails to resolve
the module, on every file, every run. `npm run verify` (or `pnpm --filter @oneunit/redis verify`)
orders all five correctly; reach for it rather than the individual scripts.
`prepublishOnly` builds before testing for the same reason.

## Writing tests

Tests use **Vitest**. The configuration is in `vitest.config.ts`.

```bash
# Inside packages/redis:
npm test

# Run tests with coverage:
npm run test:coverage

# Run example scripts tests:
npm run test:examples

# Run tests in watch mode:
npm run test:watch

# From monorepo root:
pnpm --filter @oneunit/redis test
```

### Test Suite Structure

The test suite in `test/` is organized into focused directories and test files:

| Directory / Test Suite | Scope & Responsibilities |
| :------------------------- | :---------------------------------------------------------------------------------------------------- |
| `test/redis/` | Client defaults, URL normalization, BullMQ queue/worker options, health timeout, shutdown idempotency. |
| `test/pipeline/` | Batch command execution, 1-to-1 step validation, timeout guarantees, error redaction, `pipelineValues`. |
| `test/queue/` | Queue, Worker, QueueEvents lifecycles, DLQ management, error handlers. |
| `test/cache/` | L1 in-memory + L2 Redis caching, write-behind, tag invalidation, SWR, stampede protection. |
| `test/coordination/` | Distributed locks with fencing, semaphores, leases, leader election, barriers, singleton scheduler. |
| `test/rate-limit/` | Fixed/sliding window, token/leaky bucket, quotas, concurrency, burst, adaptive, load shedding. |
| `test/resilience/` | Transparent Redis outage fallback, local journal/store, recovery coordinator, TTL preservation. |
| `test/jobs/` | At-least-once BullMQ-backed jobs facade, stalled-job recovery, retries, DLQ. |
| `test/scheduled/` | Scheduled session revocation and delayed jobs. |
| `test/security/` | Plaintext credential redaction (`AUTH`/`HELLO`), prototype pollution guards, safe key names. |
| `test/performance/` | Latency bounds, concurrent health checks, high-volume pipeline throughput. |
| `test/examples/` | End-to-end execution smoke tests verifying runnable scripts in `examples/`. |
| `test/sentinel/` | Sentinel client configuration and connectivity. |
| `test/transaction/` | Multi/exec labelled transaction wrapper. |
| `test/retry/` | Retry policies, retryOperation, and retryOperationWithResult helpers. |
| `test/core-helpers/` | Key builder, serialization codec, TTL jitter, CAS, conditional writes, capability detection. |
| `test/auth-adapter/` | Refresh, session, and state store adapters for `@oneunit/auth`. |
| `test/helpers.ts` | Shared connectivity probe (`redisAvailable()`, `cachedRedisAvailable()`). |

### A regression test must fail without its fix

This is the rule that matters most here, and it is easy to get wrong. Write the
test, then reintroduce the bug and confirm the suite goes red. If it still
passes, the test is protecting nothing.

Two traps in this package specifically:

- **bullmq swallows listener exceptions.** `QueueBase.emit` catches a throwing
  listener and re-emits the event as `error`. If that also throws, it lands on
  `console.error`. So a test that only asserts "did not throw" will pass against
  a broken event handler. Assert on `console.error` instead — see
  `attachQueueEvents tolerates a missing logger on event dispatch`.
- **Some failures only appear in a fresh process.** The health-check deadline
  bug (an `unref`'d timer letting Node exit before the promise settled) is
  invisible in-process, because the test runner keeps the loop alive for other
  reasons. That test spawns a child process.

### Tests that need Redis

Anything constructing a `Queue`, `Worker`, or `QueueEvents` needs a live server:
bullmq opens a blocking connection and retries a dead port for ~30s after
`close()`, which makes a suite pointed at nothing listening both slow and
handle-leaking. Use the existing `redisAvailable()` guard so the test returns
early instead:

```ts
test("does the thing", async () => {
  if (!(await redisAvailable())) {
    return;
  }
  // ...
});
```

`redisAvailable()` comes from `test/helpers.ts` — import it, do not redeclare
it. It used to be copied into each test file, and the copies drifted: some had a
`Promise.race` backstop and some did not. There is now one implementation and
one `cachedRedisAvailable()` per file, so the guard that decides whether the
server-backed half of the suite silently does nothing lives in a single place.

**The guard is needed for a bare `client.ping()` too, not just for bullmq
objects.** `createClient` defaults `maxRetriesPerRequest` to `null`, which is
what bullmq requires, and `null` means ioredis never gives up on a queued
command. So against a Redis that is not listening, an unguarded `await
client.ping()` parks in the offline queue and never settles — the test, and the
whole run, hangs forever rather than failing. That is not hypothetical: three
tests in `security.test.ts` were missing the guard, one of which hung the suite
indefinitely on a machine with no server. CI does not catch it, because
`.github/workflows/redis.yml` starts a Redis service for the `verify` job.

Tests for pure functions (`createClient` defaults, `health` against a fake
client, `shutdown` against a fake client) need no server. Prefer those; they are
fast and deterministic. `health` accepts any object with a `ping` method, and
`shutdown` any object with `status` and `quit`, so both are testable without
ioredis.

Two more rules that the suite has broken in the past:

- **A test must not rebuild `dist/`.** Every test file imports `../dist/index.js`
  and node's test runner executes files in parallel child processes, so anything
  that mutates the build mid-run takes `dist/` away from its siblings and
  produces `ERR_MODULE_NOT_FOUND` attributed to the wrong file. If a test needs
  the published file list, use `npm pack --dry-run --json --ignore-scripts`;
  without that flag `prepack` runs `build`, whose `clean` step deletes `dist/`.
- **Proven red before green.** See the rule above; it applies to every new
  regression test, including a fix whose "before" state is a hang.

## Working with ioredis and bullmq defaults

The single most common bug in this package's history has been forwarding an
explicit `undefined` to bullmq, which overrides a default it would otherwise
have applied. Both factories spread conditionally:

```ts
...(concurrency === undefined ? {} : { concurrency }),
```

Do not "simplify" that to `concurrency,`. If you add an option, follow the
same pattern. The same applies to `createClient`: `url` must stay the first
positional argument to the ioredis constructor, because ioredis ignores a `url`
key inside the options object and silently connects to `localhost`.

`createQueue`'s `defaultJobOptions` cannot use the conditional-spread form,
because it merges into an existing object of defaults. It merges per key instead,
skipping `undefined`. Do not "simplify" that to `...defaultJobOptions` either: a
spread writes `undefined` over every default the caller did not set. `null` is
deliberate and passes through — bullmq reads `removeOnComplete: null` as "keep
this job".

The inverse trap is just as quiet: a `url` passed as a **string** must not be
destructured as an options object either. Both mistakes end up on
`localhost:6379` with no error. `createClient` accepts a string for exactly
that reason.

Logger argument order is the other thing to get right. Every call site uses
`(message, extra)`, matching the `Logger` interface in `src/logger.ts`. pino is
the exception and takes `(bindings, message)`, so it is detected by the
`bindings()` method and `levels` map it carries — **not** by `child()`, which
this package's own interface declares and therefore cannot be a signal.

Pipelines have the same two failure modes in a new place. A command that fails
inside a pipeline does not fail the pipeline: ioredis resolves `EXEC` and puts
the error in that command's tuple, so anything that reads only the values treats
a dropped write as a success. And a pipeline `exec()` against an unreachable
server never settles, because ioredis parks queued commands while reconnecting.
`runPipeline` exists for both; keep both properties if you extend it. Anything
reaching a logger or an exception from a pipeline result goes through
`redactError` first — the step array is meant to be loggable as a whole, so the
redaction has to have already happened by the time it is returned. That applies
to a rejected `exec()` as well as to the resolved tuples; a rejection skips the
tuple mapping entirely, so redacting only the tuples leaves one path unguarded.

Results are paired with steps by **position**, so each step must queue exactly
one command. `runPipeline` enforces it by reading ioredis's own
`pipeline.length` either side of every step and raising `PipelineStepError`; do
not relax that check. Two ways of breaking it compile silently, because
TypeScript allows any value to be returned from a `void`-typed signature:

```ts
{ label: "seed", run: (p) => { p.set("a", "1"); p.set("b", "2"); } },
{ label: "x", run: async (p) => { await something(); void p.get("a"); } },
```

The first shifts every later result by one, so the caller gets a real value
against the wrong label. The second queues nothing before `exec()` is sent and
loses the command with no error anywhere. If you change how steps are queued,
keep a test that a two-command step and an `async` step both raise — and note
that a test fake standing in for ioredis has to expose a `length` that tracks
the queue, or the guard cannot be exercised at all.

Anywhere an error reaches the logger, it goes through `redactError(error)`
first. ioredis attaches the failing command to its errors, and for `AUTH` that
command's args are the password in plaintext. There are three such call sites —
the client `error` event, the `QueueEvents` `error` event, and `shutdown`'s
failure report — and adding a fourth without redacting writes the credential to
the app's log.

## Things that look like bugs but are not

- **`close` logs on every reconnect.** ioredis emits `close` on each failed
  attempt during an outage. That is expected, not a leak.
- **One client shared by queue and worker is fine.** bullmq duplicates the
  connection for its blocking needs; closing the queue or worker does not close
  your client. That is what `shutdown` is for.
- **`prefix` is not global.** It is per-call on all three factories. Set it on
  every one, or let `attachQueueEvents` inherit it from the queue.
- **`maxRetriesPerRequest` is `null` on purpose.** ioredis defaults to `20` and
  bullmq refuses anything else. See ARCHITECTURE.md.
- **`status` can stay `reconnecting` after a forced close.** `disconnect()` never
  runs ioredis's `closeHandler` from a client in `reconnecting`, so the status
  does not move to `end` even though the retry loop is gone. `shutdown` keeps its
  own record for exactly this reason; do not add a status check expecting
  otherwise.

## Publishing and Releasing

`npm run verify` is the whole gate in order: build, typecheck, lint, tests,
`pack:check`. Run it rather than the individual scripts — the pack check is what
catches a packaging mistake that no amount of unit testing will.

Two packaging rules, both learned the hard way:

- **`src` must stay in `files`.** The compiler emits sourcemaps that reference
  `../src/*.ts`. Without it they resolve to nothing in an installed package, and
  consumer stack traces silently degrade.
- **`build` must clean `dist`.** `tsc` never removes output for a deleted source
  file, so a module you delete keeps shipping its compiled copy. Do not "simplify"
  the clean step away.

The package is configured for public npm distribution under the `@oneunit` scope:

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org/"
}
```

### Direct npm CLI Publishing

`package.json` defines `"prepublishOnly": "npm run build && npm test"`, ensuring
a clean build and full test execution precede every publish:

```bash
# Inside packages/redis:
npm login
npm publish
```

### Automated CI Release Workflow

Releases are also driven by git tags: `git tag redis-v1.0.0 && git push origin redis-v1.0.0`.
`.github/workflows/redis.yml` verifies on Node 20/22/24, installs
the real tarball into a clean project and exercises the public API against a
Redis service container, then checks the tag matches `package.json` before
uploading. npm will not let you reuse a version number, so a mistyped tag is not
retryable.

## Docs and naming

The package is published as `@oneunit/redis`. Internal links, install commands,
and the repository URL should all say `oneunit`; the old `bootstrap-framework`
name is retired. Anything in this monorepo that still imports the redis plugin
by the old name will not resolve, and the server's optional redis plugin reports
that as "package not installed" rather than naming the fault. Update
`CHANGELOG.md` under an `Unreleased` heading as part of your change — a bug fix
without a changelog entry will be asked for.

## Examples

`examples/` is shipped in the tarball and exercised by CI, so an example that
does not run is a broken build. Each script reads `REDIS_URL` and honours
`REDIS_SILENT=true`. Check yours against a local Redis before sending it.
