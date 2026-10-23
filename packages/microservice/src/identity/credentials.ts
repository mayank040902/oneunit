import { ServiceCredentials } from '../config/schema.js';

export interface CredentialProvider {
  getCredentials(serviceId: string): Promise<ServiceCredentials | null>;
  rotateCredentials(serviceId: string): Promise<ServiceCredentials>;
  revokeCredentials(serviceId: string): Promise<void>;
}

export type { ServiceCredentials } from '../config/schema.js';

export interface CredentialStore {
  store(serviceId: string, credentials: ServiceCredentials): Promise<void>;
  retrieve(serviceId: string): Promise<ServiceCredentials | null>;
  delete(serviceId: string): Promise<void>;
  list(): Promise<string[]>;
}

export class MemoryCredentialStore implements CredentialStore {
  private credentials: Map<string, ServiceCredentials> = new Map();

  async store(serviceId: string, credentials: ServiceCredentials): Promise<void> {
    this.credentials.set(serviceId, credentials);
  }

  async retrieve(serviceId: string): Promise<ServiceCredentials | null> {
    return this.credentials.get(serviceId) ?? null;
  }

  async delete(serviceId: string): Promise<void> {
    this.credentials.delete(serviceId);
  }

  async list(): Promise<string[]> {
    return Array.from(this.credentials.keys());
  }
}

const SERVICE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class FileCredentialStore implements CredentialStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private validateServiceId(serviceId: string): void {
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      throw new Error('Invalid service ID: must be non-empty string');
    }
    if (serviceId.includes('/') || serviceId.includes('\\') || serviceId.includes('\0')) {
      throw new Error('Invalid service ID: contains path separator or null byte');
    }
    if (serviceId === '.' || serviceId === '..') {
      throw new Error('Invalid service ID: traversal detected');
    }
    if (!SERVICE_ID_RE.test(serviceId)) {
      throw new Error('Invalid service ID: must match strict format');
    }
  }

  private async resolvePath(serviceId: string): Promise<string> {
    this.validateServiceId(serviceId);
    const pathMod = await import('node:path');
    const resolvedBase = pathMod.resolve(this.basePath);
    const resolvedFile = pathMod.resolve(resolvedBase, `${serviceId}.json`);
    if (!resolvedFile.startsWith(resolvedBase + pathMod.sep)) {
      throw new Error('Invalid service ID: resolved path escapes credential directory');
    }
    return resolvedFile;
  }

  async store(serviceId: string, credentials: ServiceCredentials): Promise<void> {
    const { writeFile, mkdir } = await import('fs/promises');
    const filePath = await this.resolvePath(serviceId);
    const pathMod = await import('node:path');
    const dir = pathMod.dirname(filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: 'w' });
  }

  async retrieve(serviceId: string): Promise<ServiceCredentials | null> {
    const { readFile } = await import('fs/promises');
    try {
      const filePath = await this.resolvePath(serviceId);
      const data = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as ServiceCredentials;
    } catch {
      return null;
    }
  }

  async delete(serviceId: string): Promise<void> {
    const { unlink } = await import('fs/promises');
    try {
      const filePath = await this.resolvePath(serviceId);
      await unlink(filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async list(): Promise<string[]> {
    const { readdir } = await import('fs/promises');
    try {
      const files = await readdir(this.basePath);
      const result: string[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        try {
          this.validateServiceId(id);
          result.push(id);
        } catch {
          // skip malformed entries
        }
      }
      return result;
    } catch {
      return [];
    }
  }
}

export async function createCredentialProvider(
  type: 'memory' | 'file',
  options?: { path?: string }
): Promise<CredentialProvider> {
  let store: CredentialStore;
  
  if (type === 'memory') {
    store = new MemoryCredentialStore();
  } else {
    if (!options?.path) {
      throw new Error('File credential store requires a path');
    }
    store = new FileCredentialStore(options.path);
  }

  return {
    async getCredentials(serviceId: string) {
      return store.retrieve(serviceId);
    },
    
    async rotateCredentials(serviceId: string) {
      const old = await store.retrieve(serviceId);
      if (!old) {
        throw new Error(`No credentials found for service: ${serviceId}`);
      }
      
      const rotated: ServiceCredentials = {
        ...old,
        issuedAt: Date.now(),
        expiresAt: old.expiresAt ? Date.now() + (old.expiresAt - old.issuedAt) : undefined,
      };
      
      await store.store(serviceId, rotated);
      return rotated;
    },
    
    async revokeCredentials(serviceId: string) {
      await store.delete(serviceId);
    },
  };
}