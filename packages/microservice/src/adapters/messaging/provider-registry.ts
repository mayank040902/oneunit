import { Logger } from '../../observability/logger.js';
import { MessagingAdapter, MessagingAdapterConfig, MessagingAdapterFactory } from './factory.js';

export interface ProviderConstructor {
  create(config: Record<string, unknown>, logger?: Logger): Promise<MessagingAdapter> | MessagingAdapter;
}

export class MessagingProviderRegistry implements MessagingAdapterFactory {
  private providers: Map<string, ProviderConstructor> = new Map();

  register(provider: string, constructor: ProviderConstructor): void {
    this.providers.set(provider, constructor);
  }

  unregister(provider: string): boolean {
    return this.providers.delete(provider);
  }

  has(provider: string): boolean {
    return this.providers.has(provider);
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }

  async create(config: MessagingAdapterConfig, logger?: Logger): Promise<MessagingAdapter> {
    const { provider, ...providerConfig } = config;
    const constructor = this.providers.get(provider);
    if (!constructor) {
      throw new Error(`Provider '${provider}' not registered. Available providers: ${this.list().join(', ')}`);
    }
    return constructor.create(providerConfig, logger);
  }
}
