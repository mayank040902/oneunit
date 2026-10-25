/* eslint-disable */
import { Redis } from "ioredis";
import type { Logger } from "../logger.js";
import { createCoordinationKeyBuilder } from "./utils.js";
import { generateOwnershipToken, validateLeaseDuration, validateResource, sleep, validateTimeout } from "./utils.js";
import type {
  LeaderElectionOptions,
  LeaderElectionStatus,
  LeaderElectionEvent,
} from "./types.js";

const ACQUIRE_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local leaseMs = tonumber(ARGV[2])
local candidateId = ARGV[3]
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local curToken = redis.call('HGET', key, 'token')
local expires = redis.call('HGET', key, 'expires')
if curToken and expires and tonumber(expires) > now and curToken ~= token then
  return {0, curToken, tonumber(expires)}
end
local term = redis.call('HGET', key, 'term')
if not term then term = '0' end
term = tonumber(term) + 1
redis.call('HSET', key, 'token', token, 'expires', tostring(now + leaseMs), 'term', tostring(term), 'leaderId', candidateId)
redis.call('PEXPIRE', key, leaseMs + 1000)
return {1, token, term, now + leaseMs}
`;

const RENEW_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local leaseMs = tonumber(ARGV[2])
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
local curToken = redis.call('HGET', key, 'token')
if curToken ~= token then
  return {0, 'ownership_lost'}
end
local expires = redis.call('HGET', key, 'expires')
if not expires or tonumber(expires) <= now then
  return {0, 'expired'}
end
local newExpires = now + leaseMs
redis.call('HSET', key, 'expires', tostring(newExpires))
redis.call('PEXPIRE', key, leaseMs + 1000)
local term = redis.call('HGET', key, 'term')
return {1, term, newExpires}
`;

const RELEASE_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local curToken = redis.call('HGET', key, 'token')
if curToken ~= token then
  return {0}
end
redis.call('DEL', key)
return {1}
`;

export class LeaderElectionCoordinator {
  private isLeaderFlag = false;
  private term = 0;
  private leaseExpiresAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private token: string | null = null;
  private readonly events: LeaderElectionEvent[] = [];

  constructor(
    private readonly client: Redis,
    private readonly keyBuilder: ReturnType<typeof createCoordinationKeyBuilder>,
    private readonly options: LeaderElectionOptions,
    private readonly logger?: Logger,
  ) {}

  private key() {
    return this.keyBuilder.leaderElection(this.options.resource);
  }

  private emit(type: LeaderElectionEvent["type"], partial: Partial<LeaderElectionEvent> = {}) {
    const event: LeaderElectionEvent = {
      type,
      timestamp: Date.now(),
      leaderId: this.options.candidateId,
      term: this.term,
      ...partial,
    };
    this.events.push(event);
    this.options.onEvent?.(event);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    validateResource(this.options.resource);
    validateLeaseDuration(this.options.leaseMs);
    this.token = generateOwnershipToken();
    await this.tryAcquireOrRenew(true);
    const renewalInterval = this.options.renewalIntervalMs ?? Math.max(100, Math.floor(this.options.leaseMs / 3));
    this.timer = setInterval(() => {
      void this.tick();
    }, renewalInterval);
    (this.timer as any)?.unref?.();
  }

  private async tryAcquireOrRenew(initial: boolean) {
    if (this.options.signal?.aborted) return;
    const token = this.token!;
    const res = (await (this.client as any).eval(ACQUIRE_LUA, 1, this.key(), token, this.options.leaseMs, this.options.candidateId)) as any[];
    if (Array.isArray(res) && res[0] === 1) {
      const wasLeader = this.isLeaderFlag;
      this.isLeaderFlag = true;
      this.term = Number(res[2]);
      this.leaseExpiresAt = Number(res[3]);
      if (!wasLeader || initial) {
        this.emit("leader-acquired");
      }
      return true;
    }
    if (this.isLeaderFlag) {
      this.isLeaderFlag = false;
      this.emit("leader-lost");
    }
    return false;
  }

  private async tick() {
    if (this.options.signal?.aborted) {
      await this.stop();
      return;
    }
    if (!this.isLeaderFlag) {
      await this.tryAcquireOrRenew(false).catch((e) => this.emit("leader-error", { error: e as Error }));
      return;
    }
    const token = this.token!;
    const res = (await (this.client as any).eval(RENEW_LUA, 1, this.key(), token, this.options.leaseMs)) as any[];
    if (Array.isArray(res) && res[0] === 1) {
      this.term = Number(res[1]);
      this.leaseExpiresAt = Number(res[2]);
      return;
    }
    this.isLeaderFlag = false;
    this.emit("leader-lost");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    if (this.token) {
      await (this.client as any).eval(RELEASE_LUA, 1, this.key(), this.token).catch(() => {});
    }
    const wasLeader = this.isLeaderFlag;
    this.isLeaderFlag = false;
    if (wasLeader) this.emit("leader-lost");
  }

  isLeader(): boolean {
    return this.isLeaderFlag;
  }

  status(): LeaderElectionStatus {
    return {
      isLeader: this.isLeaderFlag,
      leaderId: this.options.candidateId,
      leaseExpiresAt: this.leaseExpiresAt,
      term: this.term,
    };
  }
}
