// Cryptographic attack harness for @oneunit/microservice encryption.
//
// Exercises the EncryptionService against realistic attacks and verifies
// that each attack is detected (decryption fails/auth tag mismatch) rather
// than silently returning corrupted plaintext.
//
// Run with:
//   node examples/encryption-attack.ts

import { EncryptionService } from '@oneunit/microservice';

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
  const chacha = await EncryptionService.create('chacha20-poly1305', key);

  // --- Legitimate round trip (control) ---
  const plain = new TextEncoder().encode('order-service payload: {"orderId":"abc","total":12.50}');
  const enc = await svc.encrypt(plain);
  const dec = await svc.decrypt({ ciphertext: enc.ciphertext, nonce: enc.nonce, tag: enc.tag });
  assert(Buffer.from(dec).toString() === Buffer.from(plain).toString(), 'legitimate decrypt round-trip');

  // --- Ciphertext tampering must be detected ---
  await expectReject(
    svc.decrypt({ ciphertext: flipByte(enc.ciphertext, 0), nonce: enc.nonce, tag: enc.tag }),
    'ciphertext bit flip rejected (auth tag)',
  );

  // --- Nonce tampering must be detected ---
  await expectReject(
    svc.decrypt({ ciphertext: enc.ciphertext, nonce: flipByte(enc.nonce, 0), tag: enc.tag }),
    'nonce bit flip rejected (auth tag)',
  );

  // --- Auth tag tampering must be detected ---
  await expectReject(
    svc.decrypt({ ciphertext: enc.ciphertext, nonce: enc.nonce, tag: flipByte(enc.tag, 0) }),
    'auth tag bit flip rejected',
  );

  // --- Wrong key must be rejected ---
  const otherKey = await EncryptionService.generateKey('aes-256-gcm');
  const otherSvc = await EncryptionService.create('aes-256-gcm', otherKey);
  await expectReject(
    otherSvc.decrypt({ ciphertext: enc.ciphertext, nonce: enc.nonce, tag: enc.tag }),
    'wrong key rejected',
  );

  // --- Truncated ciphertext must be rejected ---
  await expectReject(
    svc.decrypt({ ciphertext: enc.ciphertext.slice(0, -1), nonce: enc.nonce, tag: enc.tag }),
    'truncated ciphertext rejected',
  );

  // --- Truncated tag must be rejected ---
  await expectReject(
    svc.decrypt({ ciphertext: enc.ciphertext, nonce: enc.nonce, tag: enc.tag.slice(0, -1) }),
    'truncated tag rejected',
  );

  // --- AAD tampering must be detected ---
  const encAad = await svc.encrypt(plain, new TextEncoder().encode('aad-1'));
  await expectReject(
    svc.decrypt({ ciphertext: encAad.ciphertext, nonce: encAad.nonce, tag: encAad.tag, associatedData: new TextEncoder().encode('aad-2') }),
    'AAD mismatch rejected',
  );
  const decAad = await svc.decrypt({
    ciphertext: encAad.ciphertext,
    nonce: encAad.nonce,
    tag: encAad.tag,
    associatedData: new TextEncoder().encode('aad-1'),
  });
  assert(Buffer.from(decAad).toString() === Buffer.from(plain).toString(), 'correct AAD accepted');

  // --- Replay: same ciphertext/nonce re-decrypts (nonce reuse is a
  //     protocol-level concern, not a decryption failure) ---
  const decAgain = await svc.decrypt({ ciphertext: enc.ciphertext, nonce: enc.nonce, tag: enc.tag });
  assert(Buffer.from(decAgain).toString() === Buffer.from(plain).toString(), 'replay decrypt succeeds (nonce reuse is protocol-level)');

  // --- ChaCha20-Poly1305 parity ---
  const encC = await chacha.encrypt(plain);
  const decC = await chacha.decrypt({ ciphertext: encC.ciphertext, nonce: encC.nonce, tag: encC.tag });
  assert(Buffer.from(decC).toString() === Buffer.from(plain).toString(), 'chacha20 round-trip');
  await expectReject(
    chacha.decrypt({ ciphertext: flipByte(encC.ciphertext, 0), nonce: encC.nonce, tag: encC.tag }),
    'chacha20 ciphertext tampering rejected',
  );

  // --- Empty payload ---
  const encEmpty = await svc.encrypt(new Uint8Array());
  const decEmpty = await svc.decrypt({ ciphertext: encEmpty.ciphertext, nonce: encEmpty.nonce, tag: encEmpty.tag });
  assert(decEmpty.length === 0, 'empty payload round-trips');

  // --- Key derivation: same inputs -> same key (deterministic) ---
  const { deriveKey } = await import('@oneunit/microservice');
  const salt = new Uint8Array(16);
  const k1 = await deriveKey('aes-256-gcm', new TextEncoder().encode('passphrase'), salt, 100000);
  const k2 = await deriveKey('aes-256-gcm', new TextEncoder().encode('passphrase'), salt, 100000);
  assert(Buffer.from(k1).equals(Buffer.from(k2)), 'PBKDF2 derivation is deterministic');
  const k3 = await deriveKey('aes-256-gcm', new TextEncoder().encode('WRONGpass'), salt, 100000);
  assert(!Buffer.from(k1).equals(Buffer.from(k3)), 'different passphrase yields different key');

  console.log('\nEncryption attack harness complete.');
}

main().catch((error) => {
  console.error('Harness error', error);
  process.exit(1);
});