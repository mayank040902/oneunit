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

export class FileCredentialStore implements CredentialStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private getPath(serviceId: string): string {
    return `${this.basePath}/${serviceId}.json`;
  }

  async store(serviceId: string, credentials: ServiceCredentials): Promise<void> {
    const { writeFile } = await import('fs/promises');
    await writeFile(this.getPath(serviceId), JSON.stringify(credentials, null, 2));
  }

  async retrieve(serviceId: string): Promise<ServiceCredentials | null> {
    const { readFile } = await import('fs/promises');
    try {
      const data = await readFile(this.getPath(serviceId), 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async delete(serviceId: string): Promise<void> {
    const { unlink } = await import('fs/promises');
    try {
      await unlink(this.getPath(serviceId));
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async list(): Promise<string[]> {
    const { readdir } = await import('fs/promises');
    try {
      const files = await readdir(this.basePath);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5));
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