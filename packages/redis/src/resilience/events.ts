import {
  type ResilienceEvent,
  type ResilienceEventHandler,
} from "./types.js";

/**
 * Emits structured lifecycle events to registered handlers. Events are delivered
 * synchronously and best-effort: a throwing handler does not break the engine,
 * and a slow handler does not block operation processing.
 *
 * Sensitive payloads are never included in events.
 */
export class ResilienceEventEmitter {
  private readonly handlers = new Set<ResilienceEventHandler>();

  on(handler: ResilienceEventHandler): void {
    this.handlers.add(handler);
  }

  off(handler: ResilienceEventHandler): void {
    this.handlers.delete(handler);
  }

  emit(event: ResilienceEvent): void {
    const handlers = Array.from(this.handlers);
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // A misbehaving event handler must never break the engine.
      }
    }
  }

  listenerCount(): number {
    return this.handlers.size;
  }
}
