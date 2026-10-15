import { MessageContext, PublishOptions, SubscribeOptions } from '../core/capabilities.js';

export interface MessagingPort {
  publish(topic: string, message: unknown, options?: PublishOptions): Promise<void>;
  subscribe(
    topic: string,
    handler: (message: unknown, context: MessageContext) => Promise<void>,
    options?: SubscribeOptions
  ): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}
