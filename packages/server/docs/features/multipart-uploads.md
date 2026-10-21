# Multipart File Uploads

## Overview & Purpose

The **Multipart Plugin** integrates `@fastify/multipart` into `@oneunit/server`, providing support for streaming file uploads, binary attachments, and multipart form submissions (`multipart/form-data`).

It is disabled by default to avoid parsing overhead on JSON-only services. When enabled, it provides:
- **Low-Memory Streaming**: Directly pipes incoming file streams to disk, AWS S3, or Google Cloud Storage without buffering entire files in Node.js RAM.
- **Strict Resource Limits**: Enforces byte limits on file sizes, field names, text fields, and file counts to protect against disk and memory exhaustion attacks.
- **Convenient Parsing Modes**: Supports single-file (`request.file()`), multi-file iterators (`request.files()`), or body attachment (`attachFieldsToBody`).

---

## Installation & Import Requirements

```typescript
import {
  multipartPlugin,
  type MultipartPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { multipartPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @fastify/multipart
```

---

## Configuration Options

When configuring `multipart` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `multipart` | `boolean \| MultipartPluginOptions` | `false` | Disabled by default. Set to `true` or pass configuration object to enable. |
| `limits.fileSize` | `number` | Infinity | Max size of a single file in bytes (e.g. `10 * 1024 * 1024` for 10MB). |
| `limits.files` | `number` | Infinity | Max number of file fields allowed per request. |
| `limits.fields` | `number` | Infinity | Max number of non-file form fields. |
| `limits.fieldNameSize` | `number` | 100 | Max field name size in bytes. |
| `limits.fieldSize` | `number` | 1048576 (1MB) | Max field value size in bytes. |
| `limits.headerPairs` | `number` | 2000 | Max header key-value pairs parsed. |
| `limits.parts` | `number` | Infinity | Max total parts (fields + files). |
| `attachFieldsToBody` | `boolean` | `false` | When true, buffers parsed fields and files directly onto `request.body`. Use with caution for large files. |
| `throwFileSizeLimit` | `boolean` | `true` | When true, immediately throws an error if a file exceeds `fileSize`. |

---

## Usage Examples

### 1. Streaming Single File Upload (High Performance & Low Memory)

```typescript
import { startServer } from "@oneunit/server";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const { app } = await startServer({
  serviceName: "media-service",
  multipart: {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20 MB max
      files: 1,
    },
  },
  configure: (server) => {
    server.post("/upload", async (request, reply) => {
      // Stream single file directly:
      const data = await request.file();
      if (!data) {
        return reply.badRequest({ message: "No file uploaded" });
      }

      const savePath = path.join("/tmp", `${Date.now()}-${data.filename}`);
      await pipeline(data.file, createWriteStream(savePath));

      return reply.created({
        data: {
          filename: data.filename,
          mimetype: data.mimetype,
          savedTo: savePath,
        },
      });
    });
  },
});
```

### 2. Multi-File Upload Iterator

```typescript
server.post("/upload-multiple", async (request, reply) => {
  const parts = request.files();
  const uploadedFiles: string[] = [];

  for await (const part of parts) {
    const destination = path.join("/tmp", part.filename);
    await pipeline(part.file, createWriteStream(destination));
    uploadedFiles.push(part.filename);
  }

  return reply.ok({ data: { count: uploadedFiles.length, files: uploadedFiles } });
});
```

---

## Common Use Cases & Best Practices

1. **Always Stream to Cloud Storage**: Never buffer large uploads into memory. Pipe `data.file` directly to an S3 multipart upload stream or Google Cloud Storage write stream.
2. **Always Configure `fileSize` Limits**: Unbounded file uploads invite denial-of-service (DoS) attacks where malicious clients flood your server with gigabytes of data.
3. **Validate MIME Types**: Don't rely solely on `data.filename`. Verify `data.mimetype` against a whitelist of acceptable formats (`image/jpeg`, `image/png`, `application/pdf`).

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/multipart` is missing from `node_modules`, `@oneunit/server` logs a warning and skips plugin registration; calls to `request.file()` will error.
- **Consumption Requirement**: If you inspect `request.file()` or iterate `request.files()`, you must consume or discard the file streams. Abandoning an open stream will cause Fastify's request lifecycle to hang.

---

## Related Features

- [Error Handling](error-handling.md)
- [Rate Limiting](rate-limiting.md)
- [Bootstrap](bootstrap.md)
