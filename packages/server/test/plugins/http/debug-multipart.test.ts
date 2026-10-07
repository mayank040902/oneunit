import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createBootstrapServer, type BootstrapServerOptions } from "./src/bootstrap.js";

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

describe("Debug Multipart", () => {
  const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
  };

  it("debug multipart - builtin registration", async () => {
    const server = await createBootstrapServer({
      ...baseOptions,
      multipart: { limits: { fileSize: 1024 * 1024 } },
      configure: (app) => {
        app.addHook('onRequest', async (request) => {
          console.log("[test] onRequest - request.file:", typeof request.file);
          console.log("[test] onRequest - request.files:", typeof request.files);
          console.log("[test] onRequest - request.isMultipart:", typeof request.isMultipart);
        });
        
        app.post("/upload", async (request) => {
          console.log("[test] handler - request.file:", typeof request.file);
          console.log("[test] handler - request.files:", typeof request.files);
          const data = await request.file();
          if (!data) {
            return { error: "No file uploaded" };
          }
          const chunks = [];
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

    console.log("Server routes:", server.printRoutes());
    
    // Check hooks
    console.log("[test] Server hooks:", Object.keys(server.hooks || {}));
    if (server.hooks) {
      for (const [hookName, hooks] of Object.entries(server.hooks)) {
        console.log(`[test] Hook ${hookName}:`, hooks.length, "handlers");
      }
    }

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

    console.log("Status:", response.statusCode);
    console.log("Body:", response.body);
    console.log("Headers:", response.headers);

    expect(response.statusCode).toBe(200);

    await server.close();
  });
});