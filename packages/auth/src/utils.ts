import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { ValidationError } from "./errors/index.js";

const UNIT_SECONDS = Object.freeze({
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
  w: 60 * 60 * 24 * 7,
});

type TimeUnit = keyof typeof UNIT_SECONDS;

const EXPIRES_IN_PATTERN = /^(\d+)\s*([smhdw])$/i;

/**
 * True when `value` is a TTL this library can interpret unambiguously. Values
 * jsonwebtoken accepts but this library cannot (`"1y"`, `"2 hours"`, `"-5m"`)
 * are rejected so the signed token and any locally computed expiry never diverge.
 */
export function isValidExpiresIn(value: string | number | undefined | null): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "string") {
    return false;
  }
  return EXPIRES_IN_PATTERN.test(value.trim());
}

export function parseExpiresIn(value: string | number | undefined | null, fallbackSeconds = 60 * 60 * 24): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value !== "string") {
    return fallbackSeconds;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallbackSeconds;
  }

  const match = trimmed.match(EXPIRES_IN_PATTERN);
  if (!match) {
    return fallbackSeconds;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase() as TimeUnit;
  return amount * UNIT_SECONDS[unit];
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function randomState(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function timingSafeEqualString(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter((item) => item !== undefined && item !== null && item !== ""))];
}

export function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value.flat(Infinity) : [value];
}

export function pick<T extends Record<string, unknown>>(object: T, keys: Array<keyof T>): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) {
    if (object[key] !== undefined) {
      result[key] = object[key];
    }
  }
  return result;
}

export function buildUrl(base: string, path: string, query: Record<string, unknown> = {}): string {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function extractBearerToken(header: string | undefined | null): string | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  if (typeof header !== "string" || header.length === 0) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export function parseQueryString(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined && item !== null) {
        result[key] = String(Array.isArray(item) ? item[0] : item);
      }
    }
    return result;
  }
  return Object.fromEntries(new URLSearchParams(String(value)));
}

export function getHeader(
  headers: Record<string, unknown> | { get?(name: string): string | null } | undefined | null,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as { get?: unknown }).get === "function") {
    const getter = headers as { get(name: string): string | null };
    return getter.get(name) ?? getter.get(name.toLowerCase()) ?? undefined;
  }
  const map = headers as Record<string, unknown>;
  const value = map[name] ?? map[name.toLowerCase()] ?? map[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value[0] === undefined ? undefined : String(value[0]);
  }
  return value === undefined || value === null ? undefined : String(value);
}

export interface JsonRequestOptions extends RequestInit {
  timeout?: number;
}

export interface JsonResponse {
  ok: boolean;
  status: number;
  body: unknown;
  headers: Headers;
}

export async function requestJson(url: string, options: JsonRequestOptions = {}): Promise<JsonResponse> {
  const { timeout = 15000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return { ok: response.ok, status: response.status, body, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

export function formEncode(data: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  return params;
}
