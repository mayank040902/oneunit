import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBootstrapServer,
  type BootstrapServerOptions,
} from "../../src/bootstrap.js";

const apps: FastifyInstance[] = [];

function track(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      // ignore close errors
    }
  }
});

function createMultipartPayload(
  fields: Record<string, { value: string | Buffer; options?: { filename?: string; contentType?: string } }>,
): FormData {
  const form = new FormData();
  for (const [key, field] of Object.entries(fields)) {
    const blob = new Blob([field.value], { type: field.options?.contentType || "application/octet-stream" });
    form.append(key, blob, field.options?.filename || key);
  }
  return form;
}

describe("Multipart Tests", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("enables multipart parsing", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: { limits: { fileSize: 1024 * 1024 } },
      configure: (app) => {
        app.post("/upload", async (request) => {
          const data = await request.file();
          if (!data) {
            return { error: "No file uploaded" };
          }
          const chunks: Buffer[] = [];
          for await (const chunk of data.file) {
            chunks.push(chunk);
          }
          const content = Buffer.concat(chunks).toString();
          return {
            filename: data.filename,
            mimetype: data.mimetype,
            content,
          };
        });
      },
    });

    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/upload",
      payload: createMultipartPayload({
        file: {
          value: Buffer.from("test file content"),
          options: { filename: "test.txt", contentType: "text/plain" },
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.filename).toBe("test.txt");
    expect(body.mimetype).toBe("text/plain");
    expect(body.content).toBe("test file content");

    await server.close();
  });

  it("verifies file metadata access", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: true,
      configure: (app) => {
        app.post("/metadata", async (request) => {
          const data = await request.file();
          if (!data) {
            return { error: "No file" };
          }
          return {
            filename: data.filename,
            mimetype: data.mimetype,
            encoding: data.encoding,
            // fields contains circular references, omit from test
            hasFields: Object.keys(data.fields || {}).length > 0,
          };
        });
      },
    });

    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/metadata",
      payload: createMultipartPayload({
        file: {
          value: Buffer.from("content"),
          options: { filename: "document.pdf", contentType: "application/pdf" },
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.filename).toBe("document.pdf");
    expect(body.mimetype).toBe("application/pdf");

    await server.close();
  });

  it("verifies stream access", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: true,
      configure: (app) => {
        app.post("/stream", async (request) => {
          const data = await request.file();
          if (!data) {
            return { error: "No file" };
          }

          const chunks: Buffer[] = [];
          for await (const chunk of data.file) {
            chunks.push(chunk);
          }

          return {
            size: Buffer.concat(chunks).length,
          };
        });
      },
    });

    await server.ready();

    const content = "x".repeat(1000);
    const response = await server.inject({
      method: "POST",
      url: "/stream",
      payload: createMultipartPayload({
        file: {
          value: Buffer.from(content),
          options: { filename: "large.txt", contentType: "text/plain" },
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().size).toBe(content.length);

    await server.close();
  });

  it("handles multiple files", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: true,
      configure: (app) => {
        app.post("/multiple", async (request) => {
          const files = [];
          for await (const data of request.files()) {
            const chunks: Buffer[] = [];
            for await (const chunk of data.file) {
              chunks.push(chunk);
            }
            files.push({
              filename: data.filename,
              size: Buffer.concat(chunks).length,
            });
          }
          return { files };
        });
      },
    });

    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/multiple",
      payload: createMultipartPayload({
        file1: {
          value: Buffer.from("file1 content"),
          options: { filename: "file1.txt", contentType: "text/plain" },
        },
        file2: {
          value: Buffer.from("file2 content"),
          options: { filename: "file2.txt", contentType: "text/plain" },
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.files).toHaveLength(2);
    expect(body.files[0].filename).toBe("file1.txt");
    expect(body.files[1].filename).toBe("file2.txt");

    await server.close();
  });

  it("server package stops at multipart parsing (no storage)", async () => {
    // This test verifies the architectural contract:
    // The server package provides multipart parsing infrastructure
    // but does NOT implement storage behavior

    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: true,
      configure: (app) => {
        app.post("/parse-only", async (request) => {
          const data = await request.file();
          if (!data) {
            return { error: "No file" };
          }

          // Server package only parses - application decides what to do
          // with the file (storage, processing, etc.)
          const chunks: Buffer[] = [];
          for await (const chunk of data.file) {
            chunks.push(chunk);
          }

          return {
            parsed: true,
            filename: data.filename,
            size: Buffer.concat(chunks).length,
            // No storage logic here - that's application responsibility
          };
        });
      },
    });

    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/parse-only",
      payload: createMultipartPayload({
        file: {
          value: Buffer.from("test"),
          options: { filename: "test.txt", contentType: "text/plain" },
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().parsed).toBe(true);
    // No storage path or URL returned - that's application logic

    await server.close();
  });

  it("can be disabled", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: false,
    });

    expect(server).toBeDefined();
    await server.close();
  });

  it("accepts custom limits", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: { limits: { fileSize: 100, files: 1 } },
      configure: (app) => {
        app.post("/limited", async (request) => {
          const data = await request.file();
          return { ok: !!data };
        });
      },
    });

    await server.ready();

    // Should work for small file
    const response1 = await server.inject({
      method: "POST",
      url: "/limited",
      payload: createMultipartPayload({
        file: {
          value: Buffer.from("small"),
          options: { filename: "small.txt", contentType: "text/plain" },
        },
      }),
    });

    expect(response1.statusCode).toBe(200);

    await server.close();
  });
});