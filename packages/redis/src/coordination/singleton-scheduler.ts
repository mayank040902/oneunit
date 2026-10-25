/* eslint-disable */
import { generateOwnerId } from "./utils.js";
import { LeaderElectionCoordinator } from "./leader-election.js";
import type { CoordinationClientConfig } from "./types.js";
import { createCoordinationClient } from "./client.js";

export interface SingletonSchedulerOptions {
  resource: string;
  leaseMs: number;
  intervalMs: number;
  task: () => Promise<void> | void;
  candidateId?: string;
  onLeadershipChange?: (isLeader: boolean) => void;
}

export class SingletonScheduler {
  private leader: LeaderElectionCoordinator | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private started = false;

  constructor(
    private readonly coordination: ReturnType<typeof createCoordinationClient>,
    private readonly options: SingletonSchedulerOptions,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const candidateId = this.options.candidateId ?? generateOwnerId("scheduler");
    this.leader = this.coordination.createLeaderElection({
      resource: this.options.resource,
      leaseMs: this.options.leaseMs,
      candidateId,
      onEvent: (e: any) => {
        if (e.type === "leader-acquired") {
          this.startLocalLoop();
          this.options.onLeadershipChange?.(true);
        } else if (e.type === "leader-lost") {
          this.stopLocalLoop();
          this.options.onLeadershipChange?.(false);
        }
      },
    });
    await this.leader.start();
  }

  private startLocalLoop() {
    if (this.timer) return;
    this.isRunning = true;
    this.timer = setInterval(() => {
      if (!this.leader?.isLeader()) return;
      void (async () => {
        try {
          await this.options.task();
        } catch {
          // document idempotency; errors swallowed to keep loop
        }
      })();
    }, this.options.intervalMs);
    (this.timer as any)?.unref?.();
  }

  private stopLocalLoop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.stopLocalLoop();
    await this.leader?.stop();
    this.leader = null;
  }

  isLeader(): boolean {
    return this.leader?.isLeader() ?? false;
  }
}

export function createSingletonScheduler(
  config: CoordinationClientConfig,
  options: SingletonSchedulerOptions,
): SingletonScheduler {
  const coordination = createCoordinationClient(config);
  return new SingletonScheduler(coordination, options);
}

export function createSingletonSchedulerFromClient(
  coordination: ReturnType<typeof createCoordinationClient>,
  options: SingletonSchedulerOptions,
): SingletonScheduler {
  return new SingletonScheduler(coordination, options);
}
