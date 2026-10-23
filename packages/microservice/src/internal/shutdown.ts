import { EventEmitter } from 'events';

export interface ShutdownHook {
  name: string;
  priority: number;
  handler: () => Promise<void>;
}

export interface ShutdownManagerOptions {
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  logger?: { error: (...args: unknown[]) => void };
}

export class ShutdownManager extends EventEmitter {
  private hooks: ShutdownHook[] = [];
  private options: ShutdownManagerOptions;
  private shuttingDown = false;
  private completed = false;

  constructor(options: ShutdownManagerOptions = {}) {
    super();
    this.options = {
      timeoutMs: options.timeoutMs ?? 30000,
      signals: options.signals ?? ['SIGTERM', 'SIGINT', 'SIGUSR2'],
    };
    
    this.registerSignalHandlers();
  }

  registerHook(hook: ShutdownHook): void {
    this.hooks.push(hook);
    this.hooks.sort((a, b) => b.priority - a.priority);
  }

  unregisterHook(name: string): boolean {
    const index = this.hooks.findIndex(h => h.name === name);
    if (index >= 0) {
      this.hooks.splice(index, 1);
      return true;
    }
    return false;
  }

  async shutdown(reason?: string): Promise<void> {
    if (this.shuttingDown) return;
    if (this.completed) return;

    this.shuttingDown = true;
    this.emit('shutdown:started', reason);

    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Shutdown timeout')), this.options.timeoutMs);
    });

    try {
      await Promise.race([
        this.executeHooks(),
        timeout,
      ]);

      // Hooks finished before the deadline: cancel the
      // timeout timer so it cannot fire (and reject) after
      // a successful shutdown.
      clearTimeout(timeoutId);
      this.shuttingDown = false;
      this.completed = true;
      this.emit('shutdown:completed');
    } catch (err) {
      clearTimeout(timeoutId);
      this.shuttingDown = false;
      this.emit('shutdown:error', err);
      throw err;
    }
  }

  private async executeHooks(): Promise<void> {
    for (const hook of this.hooks) {
      try {
        this.emit('hook:start', hook.name);
        await hook.handler();
        this.emit('hook:complete', hook.name);
      } catch (err) {
        this.emit('hook:error', hook.name, err);
        (this.options.logger ?? console).error(`Shutdown hook ${hook.name} failed:`, err);
      }
    }
  }

  private registerSignalHandlers(): void {
    for (const signal of this.options.signals!) {
      process.on(signal, () => {
        this.shutdown(`Received ${signal}`).catch(err => {
          (this.options.logger ?? console).error('Shutdown failed:', err);
          process.exit(1);
        });
      });
    }
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  isCompleted(): boolean {
    return this.completed;
  }
}

export function createShutdownManager(options?: ShutdownManagerOptions): ShutdownManager {
  return new ShutdownManager(options);
}

export async function gracefulShutdown(
  services: Array<{ name: string; stop: () => Promise<void> }>,
  options: { timeoutMs?: number; logger?: { error: (...args: unknown[]) => void } } = {}
): Promise<void> {
  const timeout = options.timeoutMs ?? 30000;
  const startTime = Date.now();
  const errors: Error[] = [];

    for (const service of services) {
      const elapsed = Date.now() - startTime;
      const remaining = timeout - elapsed;
      
      if (remaining <= 0) {
        throw new Error('Shutdown timeout exceeded');
      }

      let timeoutId: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          service.stop(),
          new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Timeout')), remaining);
          }),
        ]);
        clearTimeout(timeoutId);
      } catch (err) {
        clearTimeout(timeoutId);
        if ((err as Error).message === 'Timeout') {
          throw new Error('Shutdown timeout exceeded');
        }
        errors.push(err as Error);
        (options.logger ?? console).error(`Failed to stop ${service.name}:`, err);
      }
    }

  if (errors.length > 0) {
    throw new Error(`Shutdown completed with errors: ${errors.map(e => e.message).join(', ')}`);
  }
}