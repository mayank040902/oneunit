import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
    createBootstrapServer,
    type BootstrapServerOptions,
} from "../../../src/bootstrap.js";
import responseManagementPlugin, {
    ERROR_RESPONSES,
    HTTP_STATUS,
    ResponseManager,
    SUCCESS_RESPONSES,
} from "../../../src/plugins/core/response-management.js";

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

const baseOptions: Partial<BootstrapServerOptions> = {
    logger: false,
    kafka: false,
    realtime: false,
    database: false,
    redis: false,
    env: false,
    health: false,
};

type RouteRegistrar = (app: FastifyInstance) => void;

/** Reply decorators are looked up by name, so the catalogue can drive the tests. */
type ReplyHelpers = Record<string, (options?: unknown) => FastifyReply>;

function helpersOf(reply: FastifyReply): ReplyHelpers {
    return reply as unknown as ReplyHelpers;
}

async function bootstrap(
    routes: RouteRegistrar,
    options: Partial<BootstrapServerOptions> = {},
): Promise<FastifyInstance> {
    const server = track(
        await createBootstrapServer({
            ...baseOptions,
            ...options,
            configure: (app) => {
                routes(app);
            },
        }),
    );
    await server.ready();
    return server;
}

describe("Response Management — success helpers", () => {
    it("reply.ok() answers with the standard envelope", async () => {
        const server = await bootstrap((app) => {
            app.get("/ok", async (_req, reply) => reply.ok());
        });

        const response = await server.inject({ method: "GET", url: "/ok" });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.success).toBe(true);
        expect(body.code).toBe("200");
        expect(body.msg).toBe("Success");
        expect(body.metadata.requestId).toBeTypeOf("string");
        expect(body.data).toBeUndefined();
    });

    it("reply.success() carries the payload, message and application code", async () => {
        const server = await bootstrap((app) => {
            app.get("/success", async (_req, reply) =>
                reply.success({
                    data: { id: 1, email: "a@b.c" },
                    message: "User created",
                    code: "USER_CREATED",
                }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/success" });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.success).toBe(true);
        expect(body.code).toBe("USER_CREATED");
        expect(body.msg).toBe("User created");
        expect(body.data).toEqual({ id: 1, email: "a@b.c" });
    });

    it("reply.created() answers 201 with the catalogue message", async () => {
        const server = await bootstrap((app) => {
            app.get("/created", async (_req, reply) => reply.created({ data: { id: 1 } }));
        });

        const response = await server.inject({ method: "GET", url: "/created" });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.success).toBe(true);
        expect(body.code).toBe("201");
        expect(body.msg).toBe(SUCCESS_RESPONSES.created.message);
        expect(body.data).toEqual({ id: 1 });
    });

    it("reply.accepted() answers 202", async () => {
        const server = await bootstrap((app) => {
            app.get("/accepted", async (_req, reply) => reply.accepted());
        });

        const response = await server.inject({ method: "GET", url: "/accepted" });

        expect(response.statusCode).toBe(202);
        expect(response.json().msg).toBe(SUCCESS_RESPONSES.accepted.message);
    });

    it("reply.noContent() answers 204 without a body", async () => {
        const server = await bootstrap((app) => {
            app.get("/no-content", async (_req, reply) => reply.noContent());
        });

        const response = await server.inject({ method: "GET", url: "/no-content" });

        expect(response.statusCode).toBe(204);
        expect(response.body).toBe("");
    });

    it("every catalogue success helper answers with its own status", async () => {
        const server = await bootstrap((app) => {
            for (const [name] of Object.entries(SUCCESS_RESPONSES)) {
                if (name === "ok" || name === "created" || name === "accepted") continue;
                app.get(`/${name}`, async (_req, reply) => helpersOf(reply)[name]());
            }
        });

        for (const [name, definition] of Object.entries(SUCCESS_RESPONSES)) {
            if (name === "ok" || name === "created" || name === "accepted") continue;
            const response = await server.inject({ method: "GET", url: `/${name}` });
            expect(response.statusCode, name).toBe(definition.status);
            const body = response.json();
            expect(body.success, name).toBe(true);
            expect(body.msg, name).toBe(definition.message);
            expect(body.code, name).toBe(String(definition.status));
        }
    });
});

describe("Response Management — error helpers", () => {
    it("reply.badRequest() answers 400 with the catalogue message", async () => {
        const server = await bootstrap((app) => {
            app.get("/bad-request", async (_req, reply) => reply.badRequest());
        });

        const response = await server.inject({ method: "GET", url: "/bad-request" });

        expect(response.statusCode).toBe(400);
        const body = response.json();
        expect(body.success).toBe(false);
        expect(body.code).toBe("400");
        expect(body.msg).toBe(ERROR_RESPONSES.badRequest.message);
    });

    it("an error helper keeps the payload it was given", async () => {
        const server = await bootstrap((app) => {
            app.get("/conflict", async (_req, reply) =>
                reply.conflict({ message: "Email already taken", data: { field: "email" } }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/conflict" });

        expect(response.statusCode).toBe(409);
        const body = response.json();
        expect(body.success).toBe(false);
        expect(body.msg).toBe("Email already taken");
        expect(body.data).toEqual({ field: "email" });
    });

    it("reply.validationError() carries the field errors", async () => {
        const server = await bootstrap((app) => {
            app.get("/invalid", async (_req, reply) =>
                reply.validationError({
                    errors: [
                        { field: "email", message: "must be an email", code: "INVALID_FORMAT" },
                    ],
                }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/invalid" });

        expect(response.statusCode).toBe(422);
        const body = response.json();
        expect(body.success).toBe(false);
        expect(body.errors).toEqual([
            { field: "email", message: "must be an email", code: "INVALID_FORMAT" },
        ]);
    });

    it("reply.error() uses the status it was given", async () => {
        const server = await bootstrap((app) => {
            app.get("/error", async (_req, reply) =>
                reply.error({ status: 409, message: "Conflict", code: "DUPLICATE" }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/error" });

        expect(response.statusCode).toBe(409);
        const body = response.json();
        expect(body.success).toBe(false);
        expect(body.code).toBe("DUPLICATE");
        expect(body.msg).toBe("Conflict");
    });

    it("reply.failed() answers 400 by default", async () => {
        const server = await bootstrap((app) => {
            app.get("/failed", async (_req, reply) => reply.failed());
        });

        const response = await server.inject({ method: "GET", url: "/failed" });

        expect(response.statusCode).toBe(400);
        expect(response.json().success).toBe(false);
    });

    it("reply.failed() honours an explicit status", async () => {
        const server = await bootstrap((app) => {
            app.get("/unavailable", async (_req, reply) => reply.failed({ status: 503 }));
        });

        const response = await server.inject({ method: "GET", url: "/unavailable" });

        expect(response.statusCode).toBe(503);
        expect(response.json().success).toBe(false);
    });

    it("every catalogue error helper answers with its own status", async () => {
        const server = await bootstrap((app) => {
            for (const [name] of Object.entries(ERROR_RESPONSES)) {
                app.get(`/${name}`, async (_req, reply) => helpersOf(reply)[name]());
            }
        });

        for (const [name, definition] of Object.entries(ERROR_RESPONSES)) {
            const response = await server.inject({ method: "GET", url: `/${name}` });
            expect(response.statusCode, name).toBe(definition.status);
            const body = response.json();
            expect(body.success, name).toBe(false);
            expect(body.msg, name).toBe(definition.message);
            expect(body.code, name).toBe(String(definition.status));
        }
    });
});

describe("Response Management — respond()", () => {
    it("answers a 2xx status with the success envelope", async () => {
        const server = await bootstrap((app) => {
            app.get("/accepted", async (_req, reply) =>
                reply.respond({ status: 202, response: { data: { jobId: 7 } } }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/accepted" });

        expect(response.statusCode).toBe(202);
        const body = response.json();
        expect(body.success).toBe(true);
        expect(body.data).toEqual({ jobId: 7 });
    });

    it("answers a 4xx status with the error envelope", async () => {
        const server = await bootstrap((app) => {
            app.get("/missing", async (_req, reply) =>
                reply.respond({ status: 404, response: { message: "User not found" } }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/missing" });

        expect(response.statusCode).toBe(404);
        const body = response.json();
        expect(body.success).toBe(false);
        expect(body.msg).toBe("User not found");
    });

    it("accepts field errors at the top level", async () => {
        const server = await bootstrap((app) => {
            app.get("/invalid", async (_req, reply) =>
                reply.respond({
                    status: 422,
                    errors: [{ field: "email", message: "must be an email" }],
                }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/invalid" });

        expect(response.statusCode).toBe(422);
        expect(response.json().errors).toEqual([
            { field: "email", message: "must be an email" },
        ]);
    });

    it("accepts field errors inside the response options", async () => {
        const server = await bootstrap((app) => {
            app.get("/invalid", async (_req, reply) =>
                reply.respond({
                    status: 422,
                    response: { errors: [{ field: "email", message: "must be an email" }] },
                }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/invalid" });

        expect(response.statusCode).toBe(422);
        expect(response.json().errors).toEqual([
            { field: "email", message: "must be an email" },
        ]);
    });

    it("answers 204 without a body", async () => {
        const server = await bootstrap((app) => {
            app.get("/empty", async (_req, reply) => reply.respond({ status: 204 }));
        });

        const response = await server.inject({ method: "GET", url: "/empty" });

        expect(response.statusCode).toBe(204);
        expect(response.body).toBe("");
    });

    it("answers 304 without a body", async () => {
        const server = await bootstrap((app) => {
            app.get("/cached", async (_req, reply) => reply.respond({ status: 304 }));
        });

        const response = await server.inject({ method: "GET", url: "/cached" });

        expect(response.statusCode).toBe(304);
        expect(response.body).toBe("");
    });

    it("refuses a redirect status", async () => {
        const server = await bootstrap((app) => {
            app.get("/redirect", async (_req, reply) => {
                try {
                    reply.respond({ status: 302 });
                    return { thrown: false };
                } catch (error) {
                    return { thrown: true, message: (error as Error).message };
                }
            });
        });

        const response = await server.inject({ method: "GET", url: "/redirect" });

        expect(response.statusCode).toBe(200);
        expect(response.json().thrown).toBe(true);
        expect(response.json().message).toContain("3xx");
    });

    it("refuses field errors on a successful response", async () => {
        const server = await bootstrap((app) => {
            app.get("/invalid", async (_req, reply) => {
                try {
                    reply.respond({ status: 200, errors: [{ field: "email", message: "nope" }] });
                    return { thrown: false };
                } catch (error) {
                    return { thrown: true, message: (error as Error).message };
                }
            });
        });

        const response = await server.inject({ method: "GET", url: "/invalid" });

        expect(response.json().thrown).toBe(true);
        expect(response.json().message).toContain("4xx/5xx");
    });

    it("refuses field errors inside the response options of a successful response", async () => {
        const server = await bootstrap((app) => {
            app.get("/invalid", async (_req, reply) => {
                try {
                    reply.respond({
                        status: 200,
                        response: { errors: [{ field: "email", message: "nope" }] },
                    });
                    return { thrown: false };
                } catch (error) {
                    return { thrown: true, message: (error as Error).message };
                }
            });
        });

        const response = await server.inject({ method: "GET", url: "/invalid" });

        expect(response.json().thrown).toBe(true);
        expect(response.json().message).toContain("4xx/5xx");
    });

    it("refuses field errors passed twice", async () => {
        const server = await bootstrap((app) => {
            app.get("/invalid", async (_req, reply) => {
                try {
                    reply.respond({
                        status: 422,
                        response: { errors: [{ field: "email", message: "nope" }] },
                        errors: [{ field: "email", message: "nope" }],
                    });
                    return { thrown: false };
                } catch (error) {
                    return { thrown: true, message: (error as Error).message };
                }
            });
        });

        const response = await server.inject({ method: "GET", url: "/invalid" });

        expect(response.json().thrown).toBe(true);
        expect(response.json().message).toContain("not both");
    });

    it("refuses a status outside the HTTP range", async () => {
        const server = await bootstrap((app) => {
            app.get("/invalid", async (_req, reply) => {
                try {
                    reply.respond({ status: 99 });
                    return { thrown: false };
                } catch (error) {
                    return { thrown: true, message: (error as Error).message };
                }
            });
        });

        const response = await server.inject({ method: "GET", url: "/invalid" });

        expect(response.json().thrown).toBe(true);
        expect(response.json().message).toContain("Invalid HTTP status");
    });
});

describe("Response Management — pagination", () => {
    it("reply.paginated() nests the pagination in the metadata", async () => {
        const server = await bootstrap((app) => {
            app.get("/users", async (_req, reply) =>
                reply.paginated({
                    data: [{ id: 1 }, { id: 2 }],
                    pagination: { total: 5, page: 1, pageSize: 2, totalPages: 3 },
                }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/users" });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.success).toBe(true);
        expect(body.data).toEqual([{ id: 1 }, { id: 2 }]);
        expect(body.metadata.pagination).toEqual({
            total: 5,
            page: 1,
            pageSize: 2,
            totalPages: 3,
        });
        expect(body.metadata.requestId).toBeTypeOf("string");
    });

    it("ResponseManager.pagination() computes the page count", () => {
        expect(ResponseManager.pagination(5, 1, 2)).toEqual({
            total: 5,
            page: 1,
            pageSize: 2,
            totalPages: 3,
        });
        expect(ResponseManager.pagination(0, 1, 10).totalPages).toBe(0);
    });

    it("ResponseManager.pagination() rejects impossible values", () => {
        expect(() => ResponseManager.pagination(-1, 1, 10)).toThrow(RangeError);
        expect(() => ResponseManager.pagination(10, 0, 10)).toThrow(RangeError);
        expect(() => ResponseManager.pagination(10, 1, 0)).toThrow(RangeError);
        expect(() => ResponseManager.pagination(10.5, 1, 10)).toThrow(RangeError);
    });

    it("refuses a pagination that contradicts the totals", async () => {
        const server = await bootstrap((app) => {
            app.get("/users", async (_req, reply) => {
                try {
                    reply.paginated({
                        data: [],
                        pagination: { total: 5, page: 1, pageSize: 2, totalPages: 99 },
                    });
                    return { thrown: false };
                } catch (error) {
                    return { thrown: true, message: (error as Error).message };
                }
            });
        });

        const response = await server.inject({ method: "GET", url: "/users" });

        expect(response.json().thrown).toBe(true);
        expect(response.json().message).toContain("totalPages");
    });
});

describe("Response Management — configuration", () => {
    it("uses the configured success message", async () => {
        const server = await bootstrap(
            (app) => {
                app.get("/ok", async (_req, reply) => reply.ok());
            },
            { responseManagement: { defaultSuccessMessage: "All good" } },
        );

        const response = await server.inject({ method: "GET", url: "/ok" });

        expect(response.json().msg).toBe("All good");
    });

    it("uses the configured error message", async () => {
        const server = await bootstrap(
            (app) => {
                app.get("/failed", async (_req, reply) => reply.failed());
            },
            { responseManagement: { defaultErrorMessage: "Something went wrong" } },
        );

        const response = await server.inject({ method: "GET", url: "/failed" });

        expect(response.json().msg).toBe("Something went wrong");
    });

    it("omits the request id when includeRequestId is false", async () => {
        const server = await bootstrap(
            (app) => {
                app.get("/ok", async (_req, reply) => reply.ok());
            },
            { responseManagement: { includeRequestId: false } },
        );

        const response = await server.inject({ method: "GET", url: "/ok" });

        const body = response.json();
        expect(body.metadata).toBeUndefined();
    });

    it("keeps the caller metadata alongside the request id", async () => {
        const server = await bootstrap((app) => {
            app.get("/ok", async (_req, reply) =>
                reply.ok({ metadata: { traceId: "trace-1" } }),
            );
        });

        const response = await server.inject({ method: "GET", url: "/ok" });

        const body = response.json();
        expect(body.metadata.traceId).toBe("trace-1");
        expect(body.metadata.requestId).toBeTypeOf("string");
    });

    it("can be disabled", async () => {
        const server = await bootstrap(
            (app) => {
                app.get("/ok", async (_req, reply) => reply.ok());
            },
            { responseManagement: false },
        );

        expect(server.hasReplyDecorator("ok")).toBe(false);
    });

    it("refuses to register the same decorators twice", async () => {
        const app = track(Fastify());
        await app.register(responseManagementPlugin);
        app.register(responseManagementPlugin);

        await expect(app.ready()).rejects.toThrow(/name already exists/);
    });
});

describe("Response Management — framework contract", () => {
    it("does not impose a schema on a plain handler result", async () => {
        const server = await bootstrap((app) => {
            app.get("/custom", async () => ({
                custom: "format",
                nested: { data: [1, 2, 3] },
            }));
        });

        const response = await server.inject({ method: "GET", url: "/custom" });

        expect(response.statusCode).toBe(200);
        expect(response.json().custom).toBe("format");
        expect(response.json().nested.data).toEqual([1, 2, 3]);
    });

    it("leaves an array result untouched", async () => {
        const server = await bootstrap((app) => {
            app.get("/array", async () => [1, 2, 3]);
        });

        const response = await server.inject({ method: "GET", url: "/array" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([1, 2, 3]);
    });

    it("leaves a framework error to the error handler", async () => {
        const server = await bootstrap((app) => {
            app.get("/throw", async () => {
                throw new Error("test error");
            });
        });

        const response = await server.inject({ method: "GET", url: "/throw" });

        expect(response.statusCode).toBe(500);
        expect(response.json().error).toBeDefined();
    });

    it("handles different status codes", async () => {
        const server = await bootstrap((app) => {
            app.get("/created", async (_req, reply) => reply.code(201).send({ created: true }));
            app.get("/no-content", async (_req, reply) => reply.code(204).send());
        });

        const created = await server.inject({ method: "GET", url: "/created" });
        expect(created.statusCode).toBe(201);
        expect(created.json().created).toBe(true);

        const noContent = await server.inject({ method: "GET", url: "/no-content" });
        expect(noContent.statusCode).toBe(204);
    });
});

describe("Response Management — catalogue", () => {
    it("exposes the HTTP status catalog", () => {
        expect(HTTP_STATUS.OK).toBe(200);
        expect(HTTP_STATUS.CREATED).toBe(201);
        expect(HTTP_STATUS.NO_CONTENT).toBe(204);
        expect(HTTP_STATUS.NOT_MODIFIED).toBe(304);
        expect(HTTP_STATUS.BAD_REQUEST).toBe(400);
        expect(HTTP_STATUS.NOT_FOUND).toBe(404);
        expect(HTTP_STATUS.TOO_MANY_REQUESTS).toBe(429);
        expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
    });

    it("keeps every error helper on a 4xx or 5xx status", () => {
        for (const [name, definition] of Object.entries(ERROR_RESPONSES)) {
            expect(definition.status, name).toBeGreaterThanOrEqual(400);
            expect(definition.status, name).toBeLessThanOrEqual(599);
            expect(definition.message.length, name).toBeGreaterThan(0);
        }
    });

    it("keeps every success helper on a 2xx status", () => {
        for (const [name, definition] of Object.entries(SUCCESS_RESPONSES)) {
            expect(definition.status, name).toBeGreaterThanOrEqual(200);
            expect(definition.status, name).toBeLessThanOrEqual(299);
            expect(definition.message.length, name).toBeGreaterThan(0);
        }
    });
});

describe("Response Management — ResponseManager", () => {
    it("builds a success envelope", () => {
        const manager = new ResponseManager();

        expect(manager.success()).toEqual({
            success: true,
            code: "200",
            msg: "Success",
        });
    });

    it("builds a success envelope for a custom status", () => {
        const manager = new ResponseManager();

        expect(manager.success({ data: { id: 1 } }, 201)).toEqual({
            success: true,
            code: "201",
            msg: "Success",
            data: { id: 1 },
        });
    });

    it("refuses a success status outside the 2xx range", () => {
        const manager = new ResponseManager();

        expect(() => manager.success({}, 100)).toThrow(RangeError);
        expect(() => manager.success({}, 302)).toThrow(RangeError);
        expect(() => manager.success({}, 500)).toThrow(RangeError);
    });

    it("refuses a body on a status that cannot carry one", () => {
        const manager = new ResponseManager();

        expect(() => manager.success({}, 204)).toThrow(RangeError);
        expect(() => manager.success({}, 205)).toThrow(RangeError);
    });

    it("builds an error envelope", () => {
        const manager = new ResponseManager();

        expect(
            manager.error({
                status: 404,
                message: "Not found",
                code: "NOT_FOUND",
                errors: [{ field: "id", message: "unknown" }],
            }),
        ).toEqual({
            success: false,
            code: "NOT_FOUND",
            msg: "Not found",
            errors: [{ field: "id", message: "unknown" }],
        });
    });

    it("refuses an error status outside the 4xx/5xx range", () => {
        const manager = new ResponseManager();

        expect(() => manager.error({ status: 200 })).toThrow(RangeError);
        expect(() => manager.error({ status: 302 })).toThrow(RangeError);
        expect(() => manager.error({ status: 600 })).toThrow(RangeError);
    });

    it("uses the configured defaults", () => {
        const manager = new ResponseManager({
            defaultSuccessMessage: "Yay",
            defaultErrorMessage: "Oops",
        });

        expect(manager.success().msg).toBe("Yay");
        expect(manager.error({ status: 500 }).msg).toBe("Oops");
    });

    it("nests the pagination in the metadata", () => {
        const manager = new ResponseManager();
        const response = manager.paginated({
            data: [1, 2],
            pagination: { total: 2, page: 1, pageSize: 2, totalPages: 1 },
        });

        expect(response.success).toBe(true);
        expect(response.data).toEqual([1, 2]);
        expect(response.metadata?.pagination).toEqual({
            total: 2,
            page: 1,
            pageSize: 2,
            totalPages: 1,
        });
    });
});
