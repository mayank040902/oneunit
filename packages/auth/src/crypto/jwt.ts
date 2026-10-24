import jwt from "jsonwebtoken";
import type { Algorithm, JwtHeader, SignOptions, VerifyOptions } from "jsonwebtoken";
import { AuthError, InvalidTokenError, TokenExpiredError, ValidationError } from "../errors/index.js";
import type { JwtPayload, JwtSignOptions, JwtVerifyOptions, Secret } from "../types/index.js";
import { isValidExpiresIn, parseExpiresIn } from "../utils.js";

const DEFAULT_ALGORITHM: Algorithm = "HS256";
const DEFAULT_EXPIRES_IN = 60 * 60 * 24;

function normalizeSecret(secret: Secret | undefined): Secret {
  if (typeof secret === "string" && secret.length > 0) {
    return secret;
  }
  if (Buffer.isBuffer(secret) && secret.length > 0) {
    return secret;
  }
  throw new ValidationError("A non-empty secret is required to sign or verify tokens");
}

function signOptions({
  expiresIn,
  subject,
  audience,
  issuer,
  jwtid,
  notBefore,
  header,
  algorithm = DEFAULT_ALGORITHM,
  keyid,
}: JwtSignOptions = {}): SignOptions {
  const options: SignOptions = { algorithm: algorithm as Algorithm };

  if (expiresIn !== undefined && expiresIn !== null) {
    // Resolve the TTL here so an unparsable value fails loudly instead of being
    // silently defaulted by parseExpiresIn while jsonwebtoken rejects it later.
    if (!isValidExpiresIn(expiresIn)) {
      throw new ValidationError(
        `Invalid expiresIn: ${JSON.stringify(expiresIn)}. Use seconds or a timespan like "15m", "7d".`,
      );
    }
    options.expiresIn = (typeof expiresIn === "number"
      ? parseExpiresIn(expiresIn)
      : expiresIn) as SignOptions["expiresIn"];
  }

  if (subject !== undefined) options.subject = String(subject);
  if (audience !== undefined) options.audience = audience;
  if (issuer !== undefined) options.issuer = issuer;
  if (jwtid !== undefined) options.jwtid = jwtid;
  if (notBefore !== undefined) options.notBefore = notBefore as SignOptions["notBefore"];
  if (keyid !== undefined) options.keyid = keyid;
  if (header !== undefined) options.header = header as unknown as JwtHeader;

  return options;
}

export function encode(payload: object = {}, secret: Secret, options: JwtSignOptions = {}): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Token payload must be an object");
  }

  const {
    expiresInSeconds,
    expiresIn = expiresInSeconds ?? DEFAULT_EXPIRES_IN,
    subject,
    ...rest
  } = options;

  try {
    const signPayload = { ...(payload as Record<string, unknown>) };
    if (subject !== undefined && signPayload.sub === undefined) {
      signPayload.sub = String(subject);
    }
    return jwt.sign(signPayload, normalizeSecret(secret), signOptions({ expiresIn, ...rest }));
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new InvalidTokenError(error instanceof Error ? error.message : "Failed to sign token", { cause: error });
  }
}

export function decode(token: string, secret: Secret, options: JwtVerifyOptions = {}): JwtPayload {
  if (!token || typeof token !== "string") {
    throw new InvalidTokenError("Token is required");
  }

  const {
    algorithms = [DEFAULT_ALGORITHM],
    audience,
    issuer,
    subject,
    clockTolerance,
    ignoreExpiration = false,
    complete = false,
  } = options;

  try {
    const verifyOptions: VerifyOptions = {
      algorithms: algorithms as Algorithm[],
      audience: audience as VerifyOptions["audience"],
      issuer,
      subject,
      clockTolerance,
      ignoreExpiration,
      complete,
    };
    return jwt.verify(token, normalizeSecret(secret), verifyOptions) as JwtPayload;
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    if (error instanceof Error && error.name === "TokenExpiredError") {
      throw new TokenExpiredError("Token has expired", { cause: error });
    }
    throw new InvalidTokenError("Invalid or expired token", { cause: error });
  }
}

export function decodeUnsafe(token: string, options: { complete?: boolean } = {}): unknown {
  if (!token || typeof token !== "string") {
    return null;
  }
  return jwt.decode(token, { complete: options.complete === true }) ?? null;
}

function withTyp(payload: object, typ: string, options: JwtSignOptions & { secret: Secret } = { secret: "" }): string {
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>), typ };
  const subject = options.subject ?? next.sub ?? next.userId;
  if (subject !== undefined && next.sub === undefined) {
    next.sub = String(subject);
  }
  return encode(next, options.secret, {
    expiresIn: options.expiresIn,
    audience: options.audience,
    issuer: options.issuer,
    jwtid: options.jwtid,
    algorithm: options.algorithm,
    header: options.header,
  });
}

export function encodeAccessToken(payload: object, secret: Secret, options: JwtSignOptions = {}): string {
  return withTyp(payload, "access", {
    ...options,
    secret,
    expiresIn: options.expiresIn ?? "15m",
  });
}

export function encodeRefreshToken(payload: object, secret: Secret, options: JwtSignOptions = {}): string {
  return withTyp(payload, "refresh", {
    ...options,
    secret,
    expiresIn: options.expiresIn ?? "7d",
  });
}

export { jwt };
