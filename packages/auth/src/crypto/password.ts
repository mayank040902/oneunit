import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { ValidationError } from "../errors/index.js";
import type { PasswordOptions } from "../types/index.js";

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

const DEFAULT_KEY_LENGTH = 64;
const DEFAULT_SALT_BYTES = 16;
const DEFAULT_COST = 16384;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELISM = 1;
const PREFIX = "scrypt";

// Every one of these values can be attacker-influenced when they come out of a
// stored hash string: N and r decide the memory block, p and keyLength decide
// the CPU time and output size, and none of them are covered by the 32MB
// maxmem guard Node applies by default. A stored hash of
// "scrypt$16384$8$1$1073741824$..." costs ~25s of CPU on a default
// configuration, on every login attempt, and costs the attacker one string to
// write. So parameters are bounded on the way in as well as on the way out, and
// a hash asking for more work than this is treated as malformed rather than
// computed.
const MIN_COST = 2;
const MAX_COST = 1 << 20;
const MIN_BLOCK_SIZE = 1;
const MAX_BLOCK_SIZE = 32;
const MIN_PARALLELISM = 1;
const MAX_PARALLELISM = 16;
const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 128;
const MAX_SALT_BYTES = 64;

// The real constraint is the product, not N on its own: scrypt needs roughly
// 128 * N * r bytes, and Node rejects anything at or above 32MB. Capping N * r
// at 24MB of working memory therefore accepts every configuration Node can
// actually run while rejecting the ones that would throw at the crypto layer.
// The default is 16MB (16384 * 8), leaving 50% headroom to raise N, r, or both.
const MAX_WORK = (24 * 1024 * 1024) / 128;

// The floor matters as much as the ceiling. A stored hash asking for a tiny
// amount of work (N=2, r=1) is a downgrade attack in slow motion: it verifies
// instantly, so an attacker able to write a hash row can brute-force passwords
// against it at enormous speed. 2^12 is three orders of magnitude below the
// default and still weaker than OWASP's recommended N=2^17, r=8.
const MIN_WORK = 1 << 12;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

/**
 * Returns null when any parameter is non-integer or outside its bounds, which
 * is what makes an over-budget stored hash uncomputable rather than slow.
 */
function parseBoundedParams(n: number, r: number, p: number, keyLength: number): ScryptParams | null {
  const values = [n, r, p, keyLength];
  if (!values.every((value) => Number.isInteger(value))) {
    return null;
  }
  if (n < MIN_COST || n > MAX_COST || (n & (n - 1)) !== 0) {
    // scrypt requires N to be a power of two greater than one.
    return null;
  }
  if (r < MIN_BLOCK_SIZE || r > MAX_BLOCK_SIZE) {
    return null;
  }
  if (n * r > MAX_WORK || n * r < MIN_WORK) {
    return null;
  }
  if (p < MIN_PARALLELISM || p > MAX_PARALLELISM) {
    return null;
  }
  if (keyLength < MIN_KEY_LENGTH || keyLength > MAX_KEY_LENGTH) {
    return null;
  }
  return { N: n, r, p, keyLength };
}

function toBuffer(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
}

export async function hashPassword(password: string, options: PasswordOptions = {}): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new ValidationError("Password must be a non-empty string");
  }

  const saltBytes = options.saltBytes ?? DEFAULT_SALT_BYTES;
  const params = parseBoundedParams(
    options.cost ?? DEFAULT_COST,
    options.blockSize ?? DEFAULT_BLOCK_SIZE,
    options.parallelism ?? DEFAULT_PARALLELISM,
    options.keyLength ?? DEFAULT_KEY_LENGTH,
  );
  if (!params) {
    throw new ValidationError(
      "Password hashing parameters are out of range: N must be a power of two in " +
        `[${MIN_COST}, ${MAX_COST}], blockSize in [${MIN_BLOCK_SIZE}, ${MAX_BLOCK_SIZE}], ` +
        `parallelism in [${MIN_PARALLELISM}, ${MAX_PARALLELISM}], keyLength in ` +
        `[${MIN_KEY_LENGTH}, ${MAX_KEY_LENGTH}], and N * blockSize must be in ` +
        `[${MIN_WORK}, ${MAX_WORK}] (24MB of working memory)`,
    );
  }
  if (saltBytes < 8 || saltBytes > MAX_SALT_BYTES) {
    throw new ValidationError(`saltBytes must be in [8, ${MAX_SALT_BYTES}]`);
  }
  const { N, r, p, keyLength } = params;
  const salt = options.salt ? toBuffer(options.salt) : randomBytes(saltBytes);

  // The bounds above are a cheap pre-filter, not a complete model of what
  // OpenSSL accepts. Node also throws synchronously for some in-range
  // combinations, so it is translated here rather than escaping as a raw
  // RangeError from a function whose contract is to report bad input.
  let key: Buffer;
  try {
    key = await scrypt(password, salt, keyLength, { N, r, p });
  } catch {
    throw new ValidationError(
      `scrypt rejected the combination N=${N}, r=${r}, p=${p}, keyLength=${keyLength} for this platform`,
    );
  }

  return [
    PREFIX,
    N,
    r,
    p,
    keyLength,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (typeof password !== "string" || typeof storedHash !== "string") {
    return false;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 7 || parts[0] !== PREFIX) {
    return false;
  }

  const [, nRaw, rRaw, pRaw, lengthRaw, saltB64, hashB64] = parts;
  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  const keyLength = Number.parseInt(lengthRaw, 10);

  // An over-budget or non-integer parameter is a malformed hash, not a slow
  // one. This check has to happen before scrypt is called: Node's own maxmem
  // guard only covers the 128 * N * r memory block, so keyLength and p are
  // otherwise unbounded and a crafted hash buys unbounded CPU per login.
  const params = parseBoundedParams(N, r, p, keyLength);
  if (!params) {
    return false;
  }

  try {
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    if (salt.length < 8 || salt.length > MAX_SALT_BYTES || expected.length !== keyLength) {
      return false;
    }
    const actual = await scrypt(password, salt, keyLength, { N: params.N, r: params.r, p: params.p });
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function needsRehash(storedHash: string, options: PasswordOptions = {}): boolean {
  if (typeof storedHash !== "string") {
    return true;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 7 || parts[0] !== PREFIX) {
    return true;
  }

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  const keyLength = Number.parseInt(parts[4], 10);

  // A hash carrying out-of-range parameters can never be verified, so it is
  // reported as needing a rehash rather than silently comparing equal to a
  // legitimate-looking configuration.
  if (!parseBoundedParams(N, r, p, keyLength)) {
    return true;
  }

  return (
    N !== (options.cost ?? DEFAULT_COST) ||
    r !== (options.blockSize ?? DEFAULT_BLOCK_SIZE) ||
    p !== (options.parallelism ?? DEFAULT_PARALLELISM) ||
    keyLength !== (options.keyLength ?? DEFAULT_KEY_LENGTH)
  );
}
