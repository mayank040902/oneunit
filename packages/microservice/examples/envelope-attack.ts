// Envelope-level cryptographic attack harness.
//
// Attacks the EncryptedEnvelope contract (the wire format the secured
// dispatcher uses) rather than the raw EncryptionService. Verifies that
// ciphertext/tag/metadata integrity holds and measures what an
// unauthenticated observer can learn from the envelope in plaintext.
//
// Run with:
//   node examples/envelope-attack.ts

import { EncryptionService } from '@oneunit/microservice';

// EncryptedEnvelope is not exported from the public API; use the structural
// shape defined in src/contracts/messages.ts so the harness does not depend
// on an internal type.
interface EncryptedEnvelope {
  version: number;
  cipherSuite: string;
  keyId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
  authenticatedMetadata: Uint8Array;
  signature?: Uint8Array;
}

interface MessageEnvelope<TPayload = unknown> {
  version: number;
  messageId: string;
  type: string;
  schemaVersion: number;
  source: { serviceId: string; instanceId: string };
  destination?: { serviceId: string };
  timestamp: number;
  correlationId?: string;
  traceContext?: Record<string, string>;
  payload: TPayload;
}

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    process.exitCode = 1;
  }
}

async function expectReject(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
    console.error(`FAIL  ${label} — expected rejection, got success`);
    process.exitCode = 1;
  } catch {
    console.log(`PASS  ${label}`);
  }
}

function flipByte(buf: Uint8Array, idx: number): Uint8Array {
  const out = new Uint8Array(buf);
  out[idx] = (out[idx] + 1) & 0xff;
  return out;
}

async function main(): Promise<void> {
  const key = await EncryptionService.generateKey('aes-256-gcm');
  const svc = await EncryptionService.create('aes-256-gcm', key);

  const envelope: MessageEnvelope<unknown> = {
    version: 1,
    messageId: 'msg-1',
    type: 'order.create',
    schemaVersion: 1,
    source: { serviceId: 'order-service', instanceId: 'inst-1' },
    destination: { serviceId: 'billing-service' },
    timestamp: Date.now(),
    correlationId: 'corr-9',
    payload: { orderId: 'abc', total: 12.5 },
  };

  const encrypted = await svc.encryptEnvelope(envelope, { keyId: 'key-2026' });

  // --- 1. Metadata confidentiality: can an observer read routing fields
  //     without the key? (authenticatedMetadata is stored in plaintext.)
  const meta = JSON.parse(new TextDecoder().decode(encrypted.authenticatedMetadata)) as {
    source: { serviceId: string; instanceId: string };
    destination: { serviceId: string };
    type: string;
    correlationId: string;
  };
  assert(meta.source.serviceId === 'order-service', 'metadata plaintext readable by observer (CONFIDENTIALITY GAP)');
  assert(meta.destination.serviceId === 'billing-service', 'destination plaintext readable by observer (CONFIDENTIALITY GAP)');
  assert(meta.type === 'order.create', 'message type plaintext readable by observer (CONFIDENTIALITY GAP)');

  // --- 2. Ciphertext tampering must be detected ---
  await expectReject(
    svc.decryptEnvelope({ ...encrypted, ciphertext: flipByte(encrypted.ciphertext, 0) }),
    'envelope ciphertext tampering rejected',
  );

  // --- 3. Authenticated metadata tampering must be detected (AAD) ---
  await expectReject(
    svc.decryptEnvelope({ ...encrypted, authenticatedMetadata: flipByte(encrypted.authenticatedMetadata, 0) }),
    'envelope metadata tampering rejected (AAD)',
  );

  // --- 4. Tag tampering must be detected ---
  await expectReject(
    svc.decryptEnvelope({ ...encrypted, tag: flipByte(encrypted.tag, 0) }),
    'envelope tag tampering rejected',
  );

  // --- 5. Nonce reuse: same nonce/ciphertext re-decrypts (no replay
  //     protection at the crypto layer) ---
  const dec = await svc.decryptEnvelope(encrypted);
  assert((dec.payload as { orderId: string }).orderId === 'abc', 'envelope round-trip');

  // --- 6. Signature field: optional and never populated. An attacker
  //     can strip it without breaking decryption. ---
  const stripped = { ...encrypted } as EncryptedEnvelope;
  delete (stripped as { signature?: Uint8Array }).signature;
  const decStripped = await svc.decryptEnvelope(stripped);
  assert((decStripped.payload as { orderId: string }).orderId === 'abc', 'missing signature does not break decryption (SIGNATURE NOT ENFORCED)');

  // --- 7. keyId is metadata only: changing it does not break decryption,
  //     so a wrong/rotated keyId is not detected at the crypto layer. ---
  const decWrongKey = await svc.decryptEnvelope({ ...encrypted, keyId: 'key-2027-rotated' });
  assert((decWrongKey.payload as { orderId: string }).orderId === 'abc', 'keyId change not detected at crypto layer (keyId is advisory only)');

  // --- 8. cipherSuite downgrade: changing the suite string is rejected
  //     because the service only knows one algorithm. ---
  await expectReject(
    svc.decryptEnvelope({ ...encrypted, cipherSuite: 'chacha20-poly1305' } as EncryptedEnvelope),
    'cipher suite mismatch rejected',
  );

  console.log('\nEnvelope attack harness complete.');
}

main().catch((error) => {
  console.error('Harness error', error);
  process.exit(1);
});