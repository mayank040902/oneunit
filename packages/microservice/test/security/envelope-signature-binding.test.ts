import { describe, it, expect } from 'vitest';
import { EncryptionService, Ed25519SigningService } from '../../src/security/index.js';

describe('sig binding', async () => {
  it('valid passes', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const svc = await EncryptionService.create('aes-256-gcm', key);
    const signer = await Ed25519SigningService.create();
    const env = { version:1, messageId:'m1', type:'t', schemaVersion:1, source:{serviceId:'s',instanceId:'i'}, timestamp:1, payload:{a:1} };
    const enc = await svc.encryptEnvelope(env as any, { keyId:'k1', signer, signatureAlgorithm:'Ed25519' });
    expect(enc.signature).toBeTruthy();
    const dec = await svc.decryptEnvelope(enc, undefined, { signaturePolicy:'required', verifier: signer });
    expect((dec.payload as any).a).toBe(1);
  });
  it('missing signature required rejects', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const svc = await EncryptionService.create('aes-256-gcm', key);
    const signer = await Ed25519SigningService.create();
    const env = { version:1, messageId:'m1', type:'t', schemaVersion:1, source:{serviceId:'s',instanceId:'i'}, timestamp:1, payload:{a:1} };
    const enc = await svc.encryptEnvelope(env as any, { keyId:'k1' }); // no signer
    await expect(svc.decryptEnvelope(enc, undefined, { signaturePolicy:'required', verifier: signer })).rejects.toThrow();
  });
  it('tampered keyId rejects signature', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const svc = await EncryptionService.create('aes-256-gcm', key);
    const signer = await Ed25519SigningService.create();
    const env = { version:1, messageId:'m1', type:'t', schemaVersion:1, source:{serviceId:'s',instanceId:'i'}, timestamp:1, payload:{a:1} };
    const enc = await svc.encryptEnvelope(env as any, { keyId:'k1', signer });
    const tampered = { ...enc, keyId:'k2' };
    await expect(svc.decryptEnvelope(tampered, undefined, { signaturePolicy:'required', verifier: signer })).rejects.toThrow();
  });
  it('invalid signature rejects', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const svc = await EncryptionService.create('aes-256-gcm', key);
    const signer = await Ed25519SigningService.create();
    const other = await Ed25519SigningService.create();
    const env = { version:1, messageId:'m1', type:'t', schemaVersion:1, source:{serviceId:'s',instanceId:'i'}, timestamp:1, payload:{a:1} };
    const enc = await svc.encryptEnvelope(env as any, { keyId:'k1', signer });
    const badSig = { ...enc, signature: new Uint8Array(enc.signature!.length) };
    await expect(svc.decryptEnvelope(badSig, undefined, { signaturePolicy:'required', verifier: other })).rejects.toThrow();
  });
});
