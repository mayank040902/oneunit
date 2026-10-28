# Pipeline Batching (`@oneunit/redis/pipeline`)

A bounded, validated pipeline wrapper around ioredis `client.pipeline()` that enforces exactly one command per step, bounds EXEC with a timeout, redacts credentials from errors, and reports per-command failures individually.

## Table of Contents

1. [Quick Start](#quick-start)
2. [runPipeline](#runpipeline)
3. [Pipeline Steps](#pipeline-steps)
4. [Pipeline Options](#pipeline-options)
5. [Results & Errors](#results--errors)
6. [pipelineValues](#pipelinevalues)
7. [Error Types](#error-types)
8. [Subpath Imports](#subpath-imports)
9. [API Reference](#api-reference)
10. [Operational Notes](#operational-notes)

---

## Quick Start

```typescript
import { runPipeline, pipelineValues } from '@oneunit/redis/pipeline';

const result = await runPipeline(redis, [
  { label: 'set:foo', run: (p) => p.set('foo', 'bar') },
  { label: 'get:foo', run: (p) => p.get('foo') },
  { label: 'ttl:foo', run: (p) => p.ttl('foo') },
], { timeout: 5000 });

// result: { results: [...], durationMs: 3, failed: 0 }

// Extract successful values only
const values = pipelineValues(result.results);
// ['OK', 'bar', -1]
```

---

## runPipeline

Executes a batch of Redis commands in a single round trip.

### Signature

```typescript
runPipeline(client, steps, options?): Promise<PipelineResult>;
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `client` | `Redis` | ioredis client |
| `steps` | `PipelineStep[]` | Commands to execute |
| `options` | `PipelineOptions` | Timeout, logger, throwOnError |

### PipelineStep

```typescript
interface PipelineStep {
  label: string;           // Human-readable identifier for error reporting
  run: (pipeline: ChainableCommander) => void; // Queues exactly one command
}
```

Each step must queue exactly one Redis command synchronously. Async steps are not supported.

```typescript
const steps = [
  { label: 'incr:counter', run: (p) => p.incr('counter') },
  { label: 'get:counter', run: (p) => p.get('counter') },
  { label: 'expire:counter', run: (p) => p.expire('counter', 3600) },
];
```

### PipelineOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `5000` ms | Max time to wait for EXEC |
| `logger` | `Logger` | — | Optional logger |
| `throwOnError` | `boolean` | — | Reject if any command failed |

---

## Pipeline Result

```typescript
interface PipelineResult {
  results: PipelineStepResult[];
  durationMs: number;
  failed: number;
}

interface PipelineStepResult {
  label: string;
  value: unknown;
  error?: Error;
}
```

Each result carries an explicit `error` field — unlike raw ioredis, failed commands are clearly marked.

```typescript
for (const r of result.results) {
  if (r.error) {
    console.error(`Step ${r.label} failed:`, r.error.message);
    continue;
  }
  console.log(`${r.label} =`, r.value);
}
```

---

## pipelineValues

Extract successful values from results. Throws if any command failed.

```typescript
import { pipelineValues } from '@oneunit/redis/pipeline';

const result = await runPipeline(redis, steps);
const values = pipelineValues(result.results);
// Throws PipelineCommandError if any step failed
```

Use `result.results` directly when partial failures are acceptable.

---

## Error Types

### PipelineTimeoutError

Thrown when EXEC does not complete within `timeout`.

```typescript
try {
  await runPipeline(redis, steps, { timeout: 1000 });
} catch (e) {
  if (e instanceof PipelineTimeoutError) {
    // EXEC hung — likely Redis unreachable
  }
}
```

### PipelineStepError

Thrown when a step does not queue exactly one command (e.g., async step, zero commands, or multiple commands).

### PipelineCommandError

Thrown when `throwOnError: true` and one or more commands failed. Carries per-step results:

```typescript
try {
  await runPipeline(redis, steps, { throwOnError: true });
} catch (e) {
  if (e instanceof PipelineCommandError) {
    for (const r of e.results) {
      if (r.error) console.error(r.label, r.error.message);
    }
  }
}
```

Error messages list only step labels — command arguments (including passwords) are redacted.

---

## Subpath Imports

```typescript
// Subpath import
import { runPipeline, pipelineValues } from '@oneunit/redis/pipeline';

// Or from root package
import { runPipeline, pipelineValues } from '@oneunit/redis';
```

---

## API Reference

```typescript
import {
  runPipeline,
  pipelineValues,
} from '@oneunit/redis/pipeline';

import type {
  PipelineStep,
  PipelineOptions,
  PipelineResult,
  PipelineStepResult,
} from '@oneunit/redis/pipeline';
```

### Exported errors

```typescript
import {
  PipelineTimeoutError,
  PipelineStepError,
  PipelineCommandError,
} from '@oneunit/redis/pipeline';
```

---

## Operational Notes

| Concern | Behavior |
|---------|----------|
| Single round trip | All commands sent in one `MULTI`/`EXEC` cycle |
| Per-command errors | Failed commands return `[error, null]` tuples; results carry explicit `error` field |
| Bounded EXEC | Timeout prevents hanging on unreachable Redis |
| Credential redaction | All error messages redacted before reaching caller/logger |
| Exactly one command | Each step must queue exactly one command; violations throw `PipelineStepError` |
| Empty batch | Returns immediately with no round trip |

---

## Example: Batch cache writes

```typescript
const result = await runPipeline(redis, [
  { label: 'set:user:1', run: (p) => p.set('user:1', JSON.stringify({ name: 'Alice' }), 'EX', 300) },
  { label: 'set:user:2', run: (p) => p.set('user:2', JSON.stringify({ name: 'Bob' }), 'EX', 300) },
  { label: 'sadd:tags', run: (p) => p.sadd('tags:users', 'user:1', 'user:2') },
], { throwOnError: true });

if (result.failed === 0) {
  console.log('All writes succeeded in', result.durationMs, 'ms');
}
```
