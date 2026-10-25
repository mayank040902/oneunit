import { type Redis as RedisClient } from "ioredis";
import { type Logger } from "../logger.js";
import { redactError } from "../client/events.js";
import {
  type ConnectionState,
} from "./types.js";
import { ResilienceEventEmitter } from "./events.js";

/**
 * Tracks the Redis connection lifecycle and exposes a stable connection state
 * to the resilience engine.
 *
 * ioredis emits `connect` before it is ready to accept commands and `ready`
 * once it can. The engine distinguishes these: `connected` means a socket is
 * open, `ready` means commands can be executed. Degraded mode is activated on
 * `close`/`reconnecting`, and cleared on `ready`.
 *
 * A single instance wires event listeners once; repeated calls are idempotent.
 */
export class ConnectionManager {
  private readonly client: RedisClient;
  private readonly logger: Logger | undefined;
  private readonly emitter: ResilienceEventEmitter;
  private state: ConnectionState = "connected";
  private outageStartMs: number | undefined;
  private ready = false;
  private wired = false;
  private initialPending = false;

  constructor(
    client: RedisClient,
    options: {
      logger?: Logger;
      emitter: ResilienceEventEmitter;
    },
  ) {
    this.client = client;
    this.logger = options.logger;
    this.emitter = options.emitter;
  }

  getState(): ConnectionState {
    return this.state;
  }

  isReady(): boolean {
    return this.ready;
  }

  getOutageStartMs(): number | undefined {
    return this.outageStartMs;
  }

  /**
   * Wire ioredis lifecycle events. Idempotent.
   * Checks the client's current status so a client that is already connected
   * or ready is not missed.
   */
  attach(): void {
    if (this.wired) {
      return;
    }
    this.wired = true;

    const client = this.client;
    const setDegraded = (reason: string): void => {
      if (this.state === "degraded" || this.state === "recovering" || this.state === "stopped") {
        return;
      }
      this.state = "degraded";
      this.ready = false;
      this.outageStartMs = Date.now();
      this.logger?.warn(`redis resilience: degraded mode activated - ${reason}`);
      this.emitter.emit({
        type: "redis.degraded",
        timestamp: this.outageStartMs,
        reason,
      });
    };

    // If the client is already ready (e.g. connect() was called before attach),
    // mark it ready immediately rather than waiting for a missed event.
    if (client.status === "ready") {
      this.ready = true;
      this.state = "connected";
    } else {
      // Client is not ready yet (e.g. lazyConnect or not yet connected) -
      // track as initial (not an outage) so recovery is not triggered for it.
      this.initialPending = true;
      setDegraded("client not yet ready");
    }

    client.on("connect", () => {
      this.logger?.debug("redis resilience: socket connected");
    });

    client.on("ready", () => {
      this.ready = true;
      if (this.initialPending) {
        this.initialPending = false;
        if (this.state !== "stopped") {
          this.state = "connected";
          this.outageStartMs = undefined;
        }
        return;
      }
      const wasDegraded = this.state === "degraded";
      if (wasDegraded) {
        // A real outage is ending: ask the engine to reconcile by emitting
        // the reconnection signal. The engine runs recovery and calls
        // beginRecovery/endRecovery.
        this.logger?.info("redis resilience: connection restored");
        this.emitter.emit({
          type: "redis.reconnected",
          timestamp: Date.now(),
        });
      } else if (this.state !== "recovering") {
        this.state = "connected";
        this.outageStartMs = undefined;
      }
    });

    client.on("reconnecting", (delay: number) => {
      this.initialPending = false;
      setDegraded(`reconnecting in ${delay ?? 0}ms`);
    });

    client.on("close", () => {
      this.initialPending = false;
      this.ready = false;
      setDegraded("connection closed");
    });

    client.on("error", (err: Error) => {
      const classified = this.classify(err);
      if (classified.kind === "connection" || classified.kind === "timeout") {
        this.initialPending = false;
        setDegraded(classified.code ?? classified.kind);
      }
      this.logger?.error("redis resilience: client error", {
        err: redactError(err),
      });
    });
  }

  /**
   * Begin an outage. Called by the engine when a command fails because Redis is
   * unreachable. Idempotent while already degraded.
   */
  markDegraded(reason: string): void {
    this.initialPending = false;
    if (this.state === "degraded" || this.state === "recovering" || this.state === "stopped") {
      return;
    }
    this.state = "degraded";
    this.ready = false;
    this.outageStartMs = Date.now();
    this.logger?.warn(`redis resilience: degraded mode activated - ${reason}`);
    this.emitter.emit({
      type: "redis.degraded",
      timestamp: this.outageStartMs,
      reason,
    });
  }

  /**
   * Transition into recovery state when Redis becomes ready after an outage.
   */
  beginRecovery(): void {
    if (this.state === "recovering") {
      return;
    }
    this.state = "recovering";
    this.ready = true;
    this.emitter.emit({
      type: "redis.recovery.started",
      timestamp: Date.now(),
    });
    this.logger?.info("redis resilience: recovery started");
  }

  /**
   * Mark recovery complete and return to normal operation.
   */
  endRecovery(durationMs?: number): void {
    if (this.state === "connected") {
      return;
    }
    this.state = "connected";
    this.ready = true;
    this.outageStartMs = undefined;
    this.emitter.emit({
      type: "redis.recovery.completed",
      timestamp: Date.now(),
      durationMs,
    });
    this.logger?.info("redis resilience: recovery completed", {
      durationMs,
    });
  }

  stop(): void {
    this.ready = false;
    this.state = "stopped";
  }

  private classify(error: unknown): { kind: string; code?: string } {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : undefined;

    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket disconnected|connection is closed/i.test(message)
    ) {
      return { kind: "connection", code };
    }

    if (/WRONGPASS|NOAUTH/i.test(message)) {
      return { kind: "auth", code: code ?? "AUTH" };
    }

    if (/READONLY|WRONGTYPE|ERR /i.test(message)) {
      return { kind: "command", code };
    }

    return { kind: "unknown", code };
  }
}
