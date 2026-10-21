# Response Management & Unified Envelope

## Overview & Purpose

The **Response Management** plugin (`responseManagementPlugin`) is enabled by default in `@oneunit/server`. It solves response inconsistency across distributed microservices by providing:
- A standardized, predictable JSON envelope shape (`success`, `code`, `msg`, optional `data`, `metadata`, and `errors`).
- Over 30 status-specific helper methods decorated directly onto Fastify's `reply` (e.g., `reply.ok()`, `reply.created()`, `reply.notFound()`, `reply.badRequest()`, `reply.paginated()`).
- Automated request correlation tracking by injecting `requestId` into metadata.
- Strict HTTP protocol compliance (e.g. guaranteeing that bodyless statuses like `204 No Content` and `304 Not Modified` never send a body).
- Safe, mathematically validated pagination helpers (`ResponseManager.pagination`).

---

## Canonical Response Envelope Specification

Every managed JSON response adheres to the `ApiResponse<T>` contract:

```typescript
interface ApiResponse<T = unknown> {
  /** True for 2xx statuses; false for 4xx and 5xx statuses */
  success: boolean;
  /** Application error/success code (defaults to the HTTP status code as a string) */
  code: string;
  /** Human-readable message */
  msg: string;
  /** Response payload data (omitted if undefined) */
  data?: T;
  /** Safe contextual metadata: pagination details, trace ID, request ID */
  metadata?: Record<string, unknown>;
  /** Structured field-level or validation error details */
  errors?: FieldError[];
}

interface FieldError {
  field: string;
  message: string;
  code?: string;
}
```

---

## Installation & Import Requirements

```typescript
import {
  ResponseManager,
  HTTP_STATUS,
  ERROR_RESPONSES,
  SUCCESS_RESPONSES,
  responseManagementPlugin,
  type ResponseManagementPluginOptions,
  type ApiResponse,
  type SuccessResponse,
  type ErrorResponse,
  type FieldError,
  type PaginationMeta,
  type PaginatedOptions,
  type RespondOptions,
} from "@oneunit/server";

// Alternatively from subpaths:
import {
  ResponseManager,
  HTTP_STATUS,
} from "@oneunit/server/plugins";
```

---

## Configuration Options

When configuring `responseManagement` in `startServer` or `createServer`:

```typescript
interface ResponseManagementPluginOptions {
  /** Default message for reply.ok() and reply.success(). Default: "Success" */
  defaultSuccessMessage?: string;
  /** Default message for reply.error() and reply.failed(). Default: "Request failed" */
  defaultErrorMessage?: string;
  /** Automatically append the Fastify request ID to metadata. Default: true */
  includeRequestId?: boolean;
}
```

To disable response management:
```typescript
const app = await createServer({ responseManagement: false });
```

---

## FastifyReply Helpers Reference

### Success Helpers (2xx)

| Helper | HTTP Status | Default Message | Notes |
| :--- | :--- | :--- | :--- |
| `reply.ok({ data, message, code, metadata })` | `200` | `"Success"` | Primary 200 helper |
| `reply.success(...)` | `200` | `"Success"` | Alias for `reply.ok()` |
| `reply.created({ data, message, code })` | `201` | `"Resource created successfully"` | Sets HTTP 201 |
| `reply.accepted({ data, message })` | `202` | `"Request accepted"` | For async background jobs |
| `reply.noContent()` | `204` | *None* | Sends empty body with status 204 |
| `reply.paginated({ data, pagination })` | `200` | `"Success"` | Automatically attaches `metadata.pagination` |

### Client Error Helpers (4xx)

| Helper | HTTP Status | Default Message |
| :--- | :--- | :--- |
| `reply.badRequest({ message, errors })` | `400` | `"Bad request"` |
| `reply.unauthorized({ message })` | `401` | `"Authentication required"` |
| `reply.paymentRequired({ message })` | `402` | `"Payment required"` |
| `reply.forbidden({ message })` | `403` | `"Access forbidden"` |
| `reply.notFound({ message })` | `404` | `"Resource not found"` |
| `reply.methodNotAllowed({ message })` | `405` | `"Method not allowed"` |
| `reply.conflict({ message })` | `409` | `"Resource conflict"` |
| `reply.gone({ message })` | `410` | `"Resource is no longer available"` |
| `reply.payloadTooLarge({ message })` | `413` | `"Request payload too large"` |
| `reply.unsupportedMediaType({ message })` | `415` | `"Unsupported media type"` |
| `reply.unprocessable({ message, errors })` | `422` | `"Request could not be processed"` |
| `reply.validationError({ message, errors })`| `422` | `"Validation failed"` |
| `reply.tooManyRequests({ message })` | `429` | `"Too many requests"` |

### Server Error Helpers (5xx)

| Helper | HTTP Status | Default Message |
| :--- | :--- | :--- |
| `reply.serverError({ message, code })` | `500` | `"Internal server error"` |
| `reply.notImplemented({ message })` | `501` | `"Not implemented"` |
| `reply.badGateway({ message })` | `502` | `"Bad gateway"` |
| `reply.serviceUnavailable({ message })` | `503` | `"Service unavailable"` |
| `reply.gatewayTimeout({ message })` | `504` | `"Gateway timeout"` |

### Generic Helpers

- **`reply.respond({ status, response, errors })`**: Send any status code (200-599 except 3xx redirects) using the envelope shape.
- **`reply.failed({ status, message, errors })`**: Send an error response with dynamic 4xx/5xx status.

---

## Usage Examples

### 1. CRUD API Endpoint Implementation

```typescript
import { createServer } from "@oneunit/server";

const app = await createServer({
  configure: (server) => {
    // 200 OK with Data
    server.get("/products/:id", async (request, reply) => {
      const product = await findProduct(request.params.id);
      if (!product) {
        return reply.notFound({ message: "Product does not exist" });
      }
      return reply.ok({ data: product });
    });

    // 201 Created
    server.post("/products", async (request, reply) => {
      const created = await createProduct(request.body);
      return reply.created({
        data: created,
        code: "PRODUCT_CREATED",
        message: "Product added to catalog",
      });
    });

    // 204 No Content
    server.delete("/products/:id", async (request, reply) => {
      await deleteProduct(request.params.id);
      return reply.noContent();
    });
  },
});
```

### 2. Paginated Responses with `ResponseManager.pagination()`

The static method `ResponseManager.pagination(total, page, pageSize)` validates integers and calculates `totalPages`:

```typescript
import { createServer, ResponseManager } from "@oneunit/server";

server.get("/products", async (request, reply) => {
  const page = Number(request.query.page ?? 1);
  const pageSize = Number(request.query.pageSize ?? 20);

  const { items, totalCount } = await queryProducts({ page, pageSize });

  return reply.paginated({
    data: items,
    pagination: ResponseManager.pagination(totalCount, page, pageSize),
  });
});
```

Sample output:
```json
{
  "success": true,
  "code": "200",
  "msg": "Success",
  "data": [{ "id": "1", "name": "Item" }],
  "metadata": {
    "requestId": "req-1a2b",
    "pagination": {
      "total": 100,
      "page": 1,
      "pageSize": 20,
      "totalPages": 5
    }
  }
}
```

### 3. Structured Field Validation Errors

```typescript
server.post("/checkout", async (request, reply) => {
  const errors = validateOrder(request.body);

  if (errors.length > 0) {
    return reply.badRequest({
      message: "Order validation failed",
      code: "INVALID_CHECKOUT_DATA",
      errors: [
        { field: "shippingAddress.zip", message: "Postal code is invalid" },
        { field: "items[0].quantity", message: "Must be greater than 0" },
      ],
    });
  }

  return reply.ok({ data: { orderId: "ord-99" } });
});
```

---

## Validation & Guard Rails

- **Bodyless Status Enforcement**: Attempting to send data with `204`, `205`, or `304` throws a runtime `RangeError`:
  ```typescript
  // Throws RangeError: HTTP 204 responses cannot carry a body; use reply.noContent()
  ResponseManager.success({}, 204);
  ```
- **Disallowed Errors on 2xx**: Attaching `errors` array to a 2xx success response is strictly forbidden and throws a `RangeError`.
- **Status Bounds**: Status codes must be valid integers between 200 and 599. Redirect statuses (300-399 except 304) cannot be passed to `reply.respond()`; Fastify's native `reply.redirect()` should be used instead.
- **Plain Handler Returns**: Handlers returning raw values without using reply helpers (e.g. `return { plain: true }`) are not wrapped, ensuring backwards compatibility with custom routes.

---

## Related Features

- [Bootstrap](bootstrap.md)
- [Error Handling](error-handling.md)
- [Data Validation with Zod](data-validation.md)
