export function generateId(): string {
  return crypto.randomUUID();
}

export function generateServiceId(): string {
  return `svc-${crypto.randomUUID().slice(0, 8)}`;
}

export function generateInstanceId(): string {
  return `inst-${crypto.randomUUID().slice(0, 8)}`;
}

export function generateMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

export function generateCorrelationId(): string {
  return `corr-${crypto.randomUUID()}`;
}

export function generateTraceId(): string {
  return crypto.randomUUID();
}

export function generateSpanId(): string {
  const uuid = crypto.randomUUID();
  return uuid.replace(/-/g, '').slice(0, 16);
}

export function generateLeaseId(): string {
  return `lease-${crypto.randomUUID()}`;
}

export function generateKeyId(): string {
  const uuid = crypto.randomUUID();
  return `key-${uuid.replace(/-/g, '').slice(0, 12)}`;
}

export function generateSessionId(): string {
  return `sess-${crypto.randomUUID()}`;
}
export type IdOptions = {
  prefix?: string;
  length?: number;
  size?: number;
  alphabet?: string;
  charset?: string;
  chars?: string;
};

const DEFAULT_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
const DEFAULT_ID_LENGTH = 21;

function resolveIdOptions(input?: string | number | IdOptions): Required<Pick<IdOptions, 'prefix' | 'length' | 'alphabet'>> {
  let prefix = '';
  let length = DEFAULT_ID_LENGTH;
  let alphabet = DEFAULT_ID_ALPHABET;

  if (typeof input === 'string') {
    prefix = input;
  } else if (typeof input === 'number') {
    length = input;
  } else if (input !== undefined) {
    prefix = input.prefix ?? '';
    length = input.length ?? input.size ?? DEFAULT_ID_LENGTH;
    alphabet = input.alphabet ?? input.charset ?? input.chars ?? DEFAULT_ID_ALPHABET;
  }

  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1) {
    throw new RangeError('id length must be a positive integer');
  }
  if (typeof alphabet !== 'string' || alphabet.length < 2) {
    throw new RangeError('id alphabet must contain at least two characters');
  }

  return { prefix, length, alphabet };
}

/**
 * Generate a compact, URL-safe, unique ID.
 *
 * @example id() // "V1StGXR8_Z5jdHi6B-myT"
 * @example id('user_') // "user_V1StGXR8_Z5jdHi6B-myT"
 * @example id(8) // "V1StGXR8"
 * @example id({ length: 12, alphabet: '0123456789' }) // "482931057482"
 *
 * Common patterns:
 * - React keys:        key={id('row_')}
 * - Database records:  id: id({ prefix: 'usr_', length: 12, alphabet: '0123456789abcdef' })
 * - Correlation IDs:   correlationId: id('corr-')
 */
export function id(
  prefixOrOptions?: string | number | IdOptions,
  lengthOrOptions?: number | IdOptions,
): string {
  let input: string | number | IdOptions | undefined = prefixOrOptions;

  if (typeof prefixOrOptions === 'string' && typeof lengthOrOptions === 'number') {
    input = { prefix: prefixOrOptions, length: lengthOrOptions };
  } else if (typeof prefixOrOptions === 'string' && typeof lengthOrOptions === 'object' && lengthOrOptions !== null) {
    input = { ...lengthOrOptions, prefix: prefixOrOptions };
  }

  const { prefix, length, alphabet } = resolveIdOptions(input);
  let result = '';

  while (result.length < length) {
    const remaining = length - result.length;
    const bytes = crypto.getRandomValues(new Uint8Array(remaining));

    for (let i = 0; i < remaining; i++) {
      const byte = bytes[i]!;
      const limit = 256 - (256 % alphabet.length);

      if (byte < limit) {
        result += alphabet[byte % alphabet.length];
        if (result.length === length) break;
      }
    }
  }

  return `${prefix}${result}`;
}

export default id;
