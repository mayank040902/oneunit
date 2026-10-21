# Response Compression

## Overview & Purpose

The **Compression Plugin** integrates `@fastify/compress` into `@oneunit/server`, providing automated HTTP payload compression across all routes.

Compressing HTTP responses dramatically reduces the number of bytes transferred over the network (often by 70-85% for JSON payloads), leading to:
- Significantly faster page loads and API response times for clients on mobile or high-latency connections.
- Lower egress bandwidth costs on cloud providers.
- Automated content negotiation supporting `gzip`, `deflate`, and modern high-ratio `brotli` (`br`) encodings based on the client's `Accept-Encoding` header.

---

## Installation & Import Requirements

```typescript
import {
  compressPlugin,
  type CompressPluginOptions,
  startServer,
  createServer,
} from "@oneunit/server";

// Alternatively from subpath:
import { compressPlugin } from "@oneunit/server/plugins";
```

Optional peer dependency:
```bash
npm install @fastify/compress
```

---

## Configuration Options

When configuring `compress` in `startServer` or `createServer`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `compress` | `boolean \| CompressPluginOptions` | `true` | Enabled by default. Set to `false` to disable. |
| `threshold` | `number` | `1024` (1 KB) | Minimum byte size of response required before compression is applied. Avoids wasting CPU compressing tiny responses. |
| `encodings` | `string[]` | `["br", "gzip", "deflate"]` | Supported encoding algorithms in priority order. |
| `filter` | `(contentType: string) => boolean` | Upstream filter | Custom predicate to selectively compress specific MIME types. |
| `global` | `boolean` | `true` | When true, applies compression to all registered routes automatically. |

---

## Usage Examples

### 1. Default Setup with Custom Threshold and Encodings

```typescript
import { startServer } from "@oneunit/server";

const { app } = await startServer({
  serviceName: "catalog-service",
  compress: {
    threshold: 2048,               // Only compress payloads >= 2KB
    encodings: ["br", "gzip"],      // Prioritize Brotli over Gzip
    filter: (contentType) => {
      // Compress JSON and text, but skip images or binary media
      return contentType.includes("json") || contentType.includes("text");
    },
  },
  configure: (server) => {
    server.get("/large-dataset", async (request, reply) => {
      const records = generateLargeDataset(); // 500 KB JSON
      // Automatically compressed using Brotli or Gzip based on Accept-Encoding
      return reply.ok({ data: records });
    });
  },
});
```

---

## Common Use Cases & Best Practices

1. **Set Realistic Thresholds**: Compressing payloads smaller than 1024 bytes (1 KB) often increases CPU overhead and can sometimes even produce larger output due to compression headers. A threshold of 1KB to 2KB is optimal.
2. **Prioritize Brotli (`br`)**: Brotli provides 15-25% better compression ratios than Gzip for text/JSON data with comparable decompression speeds on modern clients.
3. **Avoid Re-Compressing Images**: JPEG, PNG, WebP, and ZIP files are already compressed. Use `filter` or rely on default MIME filters to skip image streams.

---

## Edge Cases & Limitations

- **Peer Dependency Fallback**: If `@fastify/compress` is not installed, `@oneunit/server` logs a warning and proceeds without compressing responses.
- **Server-Sent Events (SSE)**: For long-lived streaming endpoints (like SSE `text/event-stream`), disable compression on the route level (`{ config: { compress: false } }`) to prevent buffering.

---

## Related Features

- [MessagePack](msgpack.md)
- [Response Management](response-management.md)
- [Bootstrap](bootstrap.md)
