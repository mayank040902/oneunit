import { describe, it, expect } from 'vitest';
import { EncryptionService, deriveKey } from '../../src/security/encryption.js';

describe('Encryption adversarial regression', () => {
  it('rejects non-Uint8Array plaintext', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const service = await EncryptionService.create('aes-256-gcm', key);
    await expect(service.encrypt('secret' as unknown as Uint8Array)).rejects.toThrow(
      /Uint8Array/,
    );
  });

  it('rejects null decryption input without crashing', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const service = await EncryptionService.create('aes-256-gcm', key);
    await expect(service.decrypt(null as unknown as never)).rejects.toThrow();
  });

  it('rejects malformed types in envelope', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const service = await EncryptionService.create('aes-256-gcm', key);
    await expect(service.decryptEnvelope({ foo: 'bar' } as any)).rejects.toThrow();
  });

  it('rejects tampered envelope metadata', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const service = await EncryptionService.create('aes-256-gcm', key);
    const envelope = {
      version: 1 as const,
      messageId: 'm',
      type: 't',
      schemaVersion: 1,
      source: { serviceId: 'a', instanceId: 'b' },
      timestamp: Date.now(),
      payload: { secret: 'ATTACK_TEST_SECRET_12345' },
    };
    const encrypted = await service.encryptEnvelope(envelope);
    const meta = JSON.parse(new TextDecoder().decode(encrypted.authenticatedMetadata));
    meta.type = 'evil';
    encrypted.authenticatedMetadata = new TextEncoder().encode(JSON.stringify(meta));
    await expect(service.decryptEnvelope(encrypted)).rejects.toThrow();
  });

  it('does not leak synthetic plaintext in errors', async () => {
    const key = await EncryptionService.generateKey('aes-256-gcm');
    const service = await EncryptionService.create('aes-256-gcm', key);
    const result = await service.encrypt(new TextEncoder().encode('ATTACK_TEST_SECRET_12345'));
    result.ciphertext[0] ^= 0xff;
    try {
      await service.decrypt(result);
    } catch (error) {
      expect((error as Error).message).not.toContain('ATTACK_TEST_SECRET_12345');
    }
  });

  it('rejects deriveKey password invalid type', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await expect(
      deriveKey('aes-256-gcm', 42 as unknown as string, salt),
    ).rejects.toThrow();
  });
});
