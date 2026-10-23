# Encryption Example Attack Report

## Scope

Package: `@oneunit/microservice`
Target implementation: `src/security/encryption.ts`
Examples executed:
- `node examples/encryption-attack.ts`
- `node examples/envelope-attack.ts`

Synthetic markers used: `ATTACK_TEST_SECRET_12345`, `FAKE_API_KEY_FOR_TESTING`, fake service/user identifiers. No real credentials were used or disclosed.

## Baseline behavior

Both examples completed successfully with all advertised assertions passing. Example baselines used AES-256-GCM and ChaCha20-Poly1305 with 32-byte keys, 12-byte nonces, and 16-byte authentication tags.

## Captured attack results

| Attack | Result | Notes |
|---|---|---|
| A: plaintext disclosure | PASS | Synthetic plaintext appears only in the encryption input and successful decryption output. Serialized ciphertext and metadata do not expose it. Errors do not expose it. |
| A: metadata disclosure | PASS (design) | Authenticated metadata is intentionally plaintext for routing: source, destination, type, message ID, timestamp, correlation, and tracecontext. Payload secrets are not included. |
| B: ciphertext tampering | PASS | Bit flips at start, middle, and end, append, and truncation all rejected. No plaintext returned. |
| C: authentication-tag modification | PASS | Changed, truncated, and oversized tags rejected. |
| C: nonce modification | PASS | Changed nonce rejected. |
| C: malformed/missing envelope fields | PASS | Missing, null, wrongly typed, unexpected, and nested malformed values rejected by runtime Zod validation. |
| D: wrong key | PASS | Decryption with an unrelated key rejected. |
| D: invalid key/configuration | PASS | Empty, wrong-length, mistyped keys, invalid algorithms, and invalid `deriveKey` passwords rejected. |
| E: authenticated metadata tampering | PASS | Metadata mutation and cross-envelope metadata substitution rejected through AEAD authentication. |
| E: ciphertext/tag/nonce substitution | PASS | Cross-envelope substitution rejected. |
| E: algorithm/version substitution | PASS | Unsupported or mismatched algorithm/version values rejected. |
| E: keyId/signature substitution | N/A (limitation) | `keyId` is advisory and changing it does not fail decryption. `signature` is optional and not verified by `EncryptionService`. |
| F: malformed payload/schema bypass | PASS | Runtime schema validation exists for envelopes and authenticated metadata; payload validation is available through the supplied `payloadSchema`. |
| G: replay | N/A (limitation) | Repeated valid envelopes decrypt successfully; replay prevention is not part of the encryption contract and requires `ReplayProtection` or application logic. |
| G: cross-context use | N/A (limitation) | Recipient/message context is not bound externally; consumers must compare message identifiers, timestamps, destination, and service context. |
| H: empty input | PASS | Empty plaintext is accepted and round-trips; empty or malformed ciphertext is rejected. |
| H: oversized and deeply nested inputs | PASS | Plaintext, associated data, ciphertext, and metadata size limits apply and failures are safe. |
| H: invalid encodings/type confusion | PASS | Non-`Uint8Array`, null, arrays, primitives, and incorrectly encoded strings as binary inputs are rejected before processing. |
| H: secret leakage in errors | PASS | Error paths do not include ciphertext plaintext, key material, or synthetic marker values. |

## Confirmed flaws and remediation

| Finding | Severity | Status |
|---|---|---|
| Null or mistyped decryption input could crash before validation | Medium | Fixed in `src/security/encryption.ts` |
| `deriveKey` accepted invalid password types, silently encoding them as text | Medium | Fixed with strict input validation |
| Encryption and decryption lacked complete runtime input/type validation | Medium | Fixed for plaintext, nonce, tag, associated data, metadata, and envelope fields |
| AES key material remained in `rawKey` despite a non-extractable `CryptoKey` | Medium | Fixed; AES `rawKey` is now empty after import |
| Advisory `keyId`, unverified optional `signature`, plaintext metadata, and absent replay handling | Low to Medium | Documented as design/application limitations; not changed to preserve compatibility |

## Regression coverage added

- `test/security/encryption-adversarial.test.ts`
- Existing focused encryption suite: `test/security/encryption.test.ts`

## Command results

- `node examples/encryption-attack.ts`: exit 0
- `node examples/envelope-attack.ts`: exit 0
- `pnpm run typecheck`: pass
- `pnpm run lint`: pass
- `pnpm run build`: pass
- `pnpm run verify`: pass, 71 test files and 1600 tests

## Verdict

PASS within the tested scope. Cryptographic integrity and runtime validation pass the exercised attacks. Remaining limitations are documented above and are not represented as cryptographic failures.
