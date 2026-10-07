import { describe, it, expect } from "vitest";
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalError,
  BadRequestError,
  UnprocessableError,
  ServiceUnavailableError,
  TimeoutError,
  ConfigurationError,
  DatabaseError,
  ConnectionError,
  ExternalServiceError,
  KafkaError,
  RedisError,
  WebSocketError,
  EncryptionError,
  SerializationError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ERROR_REGISTRY,
  isAppError,
  isOperationalError,
  isRetryable,
  getErrorStatusCode,
  getErrorCode,
  formatError,
} from "../src/index.js";
import { ERROR_CODES, isErrorCode } from "../src/fastify.js";

describe("Error classes", () => {
  it("AppError creates with correct properties", () => {
    const error = new AppError("Test error", "TEST_CODE", 400, { detail: "value" });
    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({ detail: "value" });
    expect(error.name).toBe("AppError");
  });

  it("AppError toJSON includes all properties", () => {
    const error = new AppError("Test", "CODE", 500, { key: "val" });
    const json = error.toJSON();
    expect(json.name).toBe("AppError");
    expect(json.message).toBe("Test");
    expect(json.code).toBe("CODE");
    expect(json.statusCode).toBe(500);
    expect(json.details).toEqual({ key: "val" });
    expect(json.stack).toBeDefined();
  });

  it("ValidationError includes fields", () => {
    const error = new ValidationError("Invalid input", { email: ["invalid format"] }, { extra: "data" });
    expect(error.fields).toEqual({ email: ["invalid format"] });
    expect(error.details).toEqual({ fields: { email: ["invalid format"] }, extra: "data" });
  });

  it("NotFoundError formats message with id", () => {
    const error = new NotFoundError("User", 123);
    expect(error.message).toBe('User with id "123" not found');
    expect(error.details?.resource).toBe("User");
    expect(error.details?.id).toBe(123);
  });

  it("NotFoundError works without id", () => {
    const error = new NotFoundError("Resource");
    expect(error.message).toBe("Resource not found");
  });

  it("NotFoundError includes falsy ids", () => {
    const zero = new NotFoundError("User", 0);
    expect(zero.message).toBe('User with id "0" not found');
    expect(zero.details?.id).toBe(0);

    const empty = new NotFoundError("User", "");
    expect(empty.message).toBe('User with id "" not found');
  });

  it("details cannot override canonical fields", () => {
    const error = new ValidationError("Invalid", { email: ["required"] }, { fields: { hacked: ["x"] } });
    expect(error.details?.fields).toEqual({ email: ["required"] });

    const notFound = new NotFoundError("User", 1, { resource: "Hacked", id: 99 });
    expect(notFound.message).toBe('User with id "1" not found');
    expect(notFound.details?.resource).toBe("User");
    expect(notFound.details?.id).toBe(1);
  });

  it("RateLimitError includes retryAfter", () => {
    const error = new RateLimitError("Too many", 60);
    expect(error.details?.retryAfter).toBe(60);
  });

  it("InternalError wraps cause", () => {
    const cause = new Error("Original error");
    const error = new InternalError("Wrapped", cause);
    expect(error.cause).toBe(cause);
  });

  it("DatabaseError includes query", () => {
    const error = new DatabaseError("Query failed", "SELECT * FROM users");
    expect(error.details?.query).toBe("SELECT * FROM users");
  });

  it("ConnectionError includes service", () => {
    const error = new ConnectionError("Redis");
    expect(error.message).toBe("Failed to connect to Redis");
    expect(error.details?.service).toBe("Redis");
  });

  it("ExternalServiceError formats correctly", () => {
    const error = new ExternalServiceError("PaymentAPI", "Timeout");
    expect(error.message).toBe("PaymentAPI: Timeout");
    expect(error.details?.service).toBe("PaymentAPI");
  });

  it("KafkaError includes topic", () => {
    const error = new KafkaError("Consumer failed", "orders");
    expect(error.details?.topic).toBe("orders");
  });

  it("RedisError includes operation", () => {
    const error = new RedisError("Get failed", "GET");
    expect(error.details?.operation).toBe("GET");
  });

  it("WebSocketError includes clientId", () => {
    const error = new WebSocketError("Send failed", "client-123");
    expect(error.details?.clientId).toBe("client-123");
  });
});

describe("Every error class", () => {
  // A wrong status or code string in any one class is invisible until it reaches
  // an HTTP response, so assert the whole matrix in one place.
  const cases: Array<[string, AppError, number, string]> = [
    ["ValidationError", new ValidationError("m", {}), 400, "VALIDATION_ERROR"],
    ["BadRequestError", new BadRequestError("m"), 400, "BAD_REQUEST"],
    ["AuthenticationError", new AuthenticationError(), 401, "AUTHENTICATION_ERROR"],
    ["AuthorizationError", new AuthorizationError(), 403, "AUTHORIZATION_ERROR"],
    ["NotFoundError", new NotFoundError("User"), 404, "NOT_FOUND"],
    ["ConflictError", new ConflictError("m"), 409, "CONFLICT"],
    ["RateLimitError", new RateLimitError(), 429, "RATE_LIMIT_EXCEEDED"],
    ["UnprocessableError", new UnprocessableError("m"), 422, "UNPROCESSABLE_ENTITY"],
    ["PayloadTooLargeError", new PayloadTooLargeError(), 413, "PAYLOAD_TOO_LARGE"],
    ["UnsupportedMediaTypeError", new UnsupportedMediaTypeError(), 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["SerializationError", new SerializationError("m"), 400, "SERIALIZATION_ERROR"],
    ["InternalError", new InternalError(), 500, "INTERNAL_ERROR"],
    ["ConfigurationError", new ConfigurationError("m"), 500, "CONFIGURATION_ERROR"],
    ["DatabaseError", new DatabaseError("m"), 500, "DATABASE_ERROR"],
    ["KafkaError", new KafkaError("m"), 500, "KAFKA_ERROR"],
    ["RedisError", new RedisError("m"), 500, "REDIS_ERROR"],
    ["WebSocketError", new WebSocketError("m"), 500, "WEBSOCKET_ERROR"],
    ["EncryptionError", new EncryptionError("m"), 500, "ENCRYPTION_ERROR"],
    ["ExternalServiceError", new ExternalServiceError("Svc", "m"), 502, "EXTERNAL_SERVICE_ERROR"],
    ["ConnectionError", new ConnectionError("Svc"), 503, "CONNECTION_ERROR"],
    ["ServiceUnavailableError", new ServiceUnavailableError(), 503, "SERVICE_UNAVAILABLE"],
    ["TimeoutError", new TimeoutError(), 504, "TIMEOUT"],
  ];

  it.each(cases)("%s reports code %s and status %s", (name, error, statusCode, code) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
    expect(getErrorStatusCode(error)).toBe(statusCode);
    expect(getErrorCode(error)).toBe(code);
    expect(isAppError(error)).toBe(true);
    expect(error.stack).toBeDefined();
    expect(error.toJSON().name).toBe(name);
  });

  it.each(cases)("%s is registered under its own code", (_name, error, _statusCode, code) => {
    expect(ERROR_REGISTRY[code]).toBeDefined();
    expect(ERROR_REGISTRY[code].name).toBe(error.name);
  });

  it.each(cases)("%s uses a code listed in ERROR_CODES", (_name, error, _statusCode, code) => {
    expect(isErrorCode(code)).toBe(true);
  });

  it("keeps ERROR_REGISTRY and ERROR_CODES in sync", () => {
    // A code in one list but not the other means either the Fastify layer or
    // the deserializer cannot handle that class.
    expect(Object.keys(ERROR_CODES).sort()).toEqual(
      [...Object.keys(ERROR_REGISTRY), "UNKNOWN_ERROR"].sort()
    );
  });

  it.each(cases)("%s agrees with isOperationalError and isRetryable", (_name, error, statusCode) => {
    expect(isOperationalError(error)).toBe(statusCode < 500);
    // 408, 425, and 429 are retryable despite being 4xx.
    expect(isRetryable(error)).toBe(statusCode >= 500 || statusCode === 429);
  });
});

describe("Type guards", () => {
  it("AppError does not expose cause as an enumerable own property", () => {
    const cause = new Error("root");
    const withCause = new AppError("mid", "CODE", 500, undefined, cause);
    expect(withCause.cause).toBe(cause);
    expect(Object.keys(withCause)).not.toContain("cause");
    expect(Object.getOwnPropertyDescriptor(withCause, "cause")?.enumerable).toBe(false);

    const withoutCause = new AppError("mid", "CODE");
    expect("cause" in withoutCause).toBe(false);
  });

  it("isAppError returns true for AppError instances", () => {
    expect(isAppError(new AppError("test", "CODE"))).toBe(true);
    expect(isAppError(new ValidationError("test", {}))).toBe(true);
    expect(isAppError(new Error("test"))).toBe(false);
    expect(isAppError("string")).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it("isAppError recognises an AppError from a duplicated package copy", () => {
    class ForeignAppError extends Error {
      constructor(public code: string, public statusCode: number, message: string) {
        super(message);
      }
      toJSON() { return { code: this.code }; }
    }

    const foreign = new ForeignAppError("TEAPOT", 418, "short and stout");
    expect(isAppError(foreign)).toBe(true);
    expect(getErrorStatusCode(foreign)).toBe(418);
    expect(getErrorCode(foreign)).toBe("TEAPOT");
  });

  it("isAppError does not claim framework errors that merely have code and statusCode", () => {
    // Fastify's own errors carry both fields but are not AppErrors, yet their
    // status is still honoured rather than collapsed to 500.
    const fastifyLike = Object.assign(new Error("not found"), {
      code: "FST_ERR_NOT_FOUND",
      statusCode: 404,
    });
    expect(isAppError(fastifyLike)).toBe(false);
    expect(getErrorStatusCode(fastifyLike)).toBe(404);
    expect(getErrorCode(fastifyLike)).toBe("INTERNAL_ERROR");
  });

  it("getErrorStatusCode ignores an out-of-range foreign status", () => {
    expect(getErrorStatusCode(Object.assign(new Error("x"), { statusCode: 999 }))).toBe(500);
    expect(getErrorStatusCode(Object.assign(new Error("x"), { statusCode: NaN }))).toBe(500);
    expect(getErrorStatusCode(Object.assign(new Error("x"), { status: 418 }))).toBe(418);
  });

  it("AppError rejects an impossible statusCode", () => {
    for (const statusCode of [0, -1, 99, 600, 100.5, Number.NaN]) {
      expect(() => new AppError("m", "C", statusCode)).toThrow(RangeError);
    }
    expect(() => new AppError("m", "C", 100)).not.toThrow();
    expect(() => new AppError("m", "C", 599)).not.toThrow();
  });

  it("isOperationalError returns true for 4xx errors", () => {
    expect(isOperationalError(new ValidationError("test", {}))).toBe(true);
    expect(isOperationalError(new AuthenticationError())).toBe(true);
    expect(isOperationalError(new NotFoundError("test"))).toBe(true);
    expect(isOperationalError(new InternalError())).toBe(false);
  });

  it("getErrorStatusCode returns correct codes", () => {
    expect(getErrorStatusCode(new ValidationError("test", {}))).toBe(400);
    expect(getErrorStatusCode(new AuthenticationError())).toBe(401);
    expect(getErrorStatusCode(new InternalError())).toBe(500);
    expect(getErrorStatusCode(new Error("test"))).toBe(500);
    expect(getErrorStatusCode("string")).toBe(500);
  });

  it("getErrorCode returns correct codes", () => {
    expect(getErrorCode(new ValidationError("test", {}))).toBe("VALIDATION_ERROR");
    expect(getErrorCode(new InternalError())).toBe("INTERNAL_ERROR");
    expect(getErrorCode(new Error("test"))).toBe("INTERNAL_ERROR");
    expect(getErrorCode("string")).toBe("UNKNOWN_ERROR");
  });

  it("formatError works for AppError", () => {
    const error = new ValidationError("Invalid", { field: ["required"] });
    const formatted = formatError(error);
    expect(formatted.code).toBe("VALIDATION_ERROR");
    expect(formatted.statusCode).toBe(400);
    expect(formatted.details).toEqual({ fields: { field: ["required"] } });
  });

  it("formatError works for plain Error", () => {
    const error = new Error("Plain error");
    const formatted = formatError(error);
    expect(formatted.code).toBe("INTERNAL_ERROR");
    expect(formatted.statusCode).toBe(500);
    expect(formatted.message).toBe("Plain error");
  });

  it("formatError works for unknown types", () => {
    const formatted = formatError("string error");
    expect(formatted.code).toBe("UNKNOWN_ERROR");
    expect(formatted.statusCode).toBe(500);
    expect(formatted.message).toBe("string error");
  });
});