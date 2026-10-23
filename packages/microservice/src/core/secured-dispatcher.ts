import type { ServiceIdentity } from '../identity/service-identity.js';
import type { Authenticator, AuthenticationResult } from '../identity/authentication.js';
import type { AuthorizationPolicy } from '../identity/authorization.js';
import type { ServiceCredentials } from '../identity/credentials.js';
import { createMicroserviceError, ErrorCodes, isMicroserviceError, sanitizeErrorDetails } from './errors.js';
import { AuditEventTypes, type AuditLogger } from '../observability/audit.js';
import type { Tracer } from '../observability/tracing.js';
import type { MetricsCollector } from '../observability/metrics.js';

export interface SecuredDispatchOptions {
  service: ServiceIdentity;
  authorization?: AuthorizationPolicy;
  authenticationEnabled?: boolean;
  requireAuthentication?: boolean;
  audit?: AuditLogger;
  authenticator?: Authenticator;
  tracer?: Tracer;
  metrics?: MetricsCollector;
  transport?: string;
}

export interface SecuredRequestContext {
  service: string;
  method: string;
  transport: string;
  operation?: string;
  targetService?: string;
  credentials?: ServiceCredentials;
  metadata?: Map<string, unknown> | ReadonlyMap<string, unknown> | Record<string, unknown>;
  attributes?: Record<string, unknown>;
  correlationId?: string;
  caller?: ServiceIdentity;
  principal?: ServiceIdentity;
  abortSignal?: AbortSignal;
}

function resolveCredentials(request: SecuredRequestContext): ServiceCredentials | undefined {
  if (request.credentials) {
    return request.credentials;
  }
  const metadata = request.metadata;
  if (metadata instanceof Map) {
    return metadata.get('credentials') as ServiceCredentials | undefined;
  }
  if (metadata && typeof metadata === 'object' && 'get' in metadata) {
    const getter = (metadata as { get?: (key: string) => unknown })['get'];
    if (typeof getter === 'function') {
      return getter('credentials') as ServiceCredentials | undefined;
    }
  }
  if (metadata && typeof metadata === 'object') {
    const creds = (metadata as Record<string, unknown>)['credentials'];
    if (creds) {
      return creds as ServiceCredentials;
    }
  }
  return undefined;
}

function writePrincipal(request: SecuredRequestContext, principal: ServiceIdentity | undefined): void {
  if (!principal) return;
  request.principal = principal;
  request.caller = principal;
  const metadata = request.metadata;
  if (metadata instanceof Map) {
    metadata.set('principal', principal);
    metadata.set('callerIdentity', principal);
    metadata.set('authenticatedPrincipal', principal);
  }
}

export class SecuredDispatcher {
  private readonly options: SecuredDispatchOptions;

  constructor(options: SecuredDispatchOptions) {
    this.options = options;
  }

  get optionsRef(): SecuredDispatchOptions {
    return this.options;
  }

  async dispatch<T>(request: SecuredRequestContext, handler: () => Promise<T> | T): Promise<T> {
    if (!request || typeof request !== 'object') {
      throw createMicroserviceError(
        ErrorCodes.INVALID_ARGUMENT,
        'Secured request context is required',
        'INVALID_ARGUMENT',
        false
      );
    }
    if (typeof request.service !== 'string' || request.service.trim() === '') {
      throw createMicroserviceError(
        ErrorCodes.INVALID_ARGUMENT,
        'Secured request service is required',
        'INVALID_ARGUMENT',
        false
      );
    }
    if (typeof request.method !== 'string' || request.method.trim() === '') {
      throw createMicroserviceError(
        ErrorCodes.INVALID_ARGUMENT,
        'Secured request method is required',
        'INVALID_ARGUMENT',
        false
      );
    }

    const service = request.service;
    const method = request.method;
    const transport = request.transport || this.options.transport || 'unknown';
    const operation = request.operation || (request.targetService ? `${request.targetService}.${method}` : `${service}.${method}`);
    const resource = method;
    const targetService = request.targetService ?? (request.service !== transport ? request.service : undefined);
    if (!request.transport) {
      request.transport = transport;
    }
    if (!request.operation) {
      request.operation = operation;
    }
    if (!request.targetService && targetService) {
      request.targetService = targetService;
    }

    const labels = { service, method };
    const tracer = this.options.tracer;
    const metrics = this.options.metrics;
    const span = tracer
      ? tracer.startSpan('rpc.handle', {
          attributes: { service, method, rpcService: service, rpcMethod: method, transport },
        })
      : undefined;
    const startedAt = Date.now();
    let spanEnded = false;

    const endSpan = (code: 'ok' | 'error', message?: string): void => {
      if (span && !spanEnded) {
        span.status = { code, message };
        try {
          tracer?.endSpan(span);
        } catch {
          // Tracing is best-effort.
        }
        spanEnded = true;
      }
    };

    try {
      // Authentication precedes authorization.
      let principal: ServiceIdentity | undefined = request.principal ?? request.caller;

      if (this.options.authenticator || this.options.requireAuthentication) {
        if (!this.options.authenticator) {
          if (this.options.requireAuthentication) {
            try {
              metrics?.incrementCounter('rpc.requests.total', { ...labels, outcome: 'unauthenticated' });
            } catch {
              // Instrumentation is best-effort.
            }
            throw createMicroserviceError(
              ErrorCodes.UNAUTHENTICATED,
              `Authentication required but not configured for ${service}.${method}`,
              'AUTHENTICATION',
              false,
              { details: { service, method } }
            );
          }
        } else {
          const credentials = resolveCredentials(request);
          let result: AuthenticationResult;
          if (!credentials) {
            result = { authenticated: false, error: 'Missing credentials' };
          } else {
            try {
              result = await this.options.authenticator.authenticate(credentials);
            } catch (err) {
              result = { authenticated: false, error: err instanceof Error ? err.message : String(err) };
            }
          }

          if (!result.authenticated) {
            try {
              await this.options.audit?.log({
                eventId: `authn-${Date.now()}`,
                eventType: AuditEventTypes.SECURITY_ALERT,
                timestamp: Date.now(),
                actor: { serviceId: this.options.service.serviceId, instanceId: this.options.service.instanceId },
                action: 'call',
                resource: { type: 'method', id: `${service}.${method}` },
                outcome: 'failure',
                details: { service, method, transport, error: result.error },
                riskLevel: 'high',
              });
            } catch {
              // Audit logging is best-effort.
            }
            try {
              metrics?.incrementCounter('rpc.requests.total', { ...labels, outcome: 'unauthenticated' });
            } catch {
              // Instrumentation is best-effort.
            }
            endSpan('error', result.error ?? 'Authentication failed');
            throw createMicroserviceError(
              ErrorCodes.UNAUTHENTICATED,
              result.error ?? `Authentication failed for ${service}.${method}`,
              'AUTHENTICATION',
              false,
              { details: { service, method } }
            );
          }
          principal = result.identity ?? principal;
          writePrincipal(request, principal);
        }
      }

      // Authorization.
      if (this.options.authenticationEnabled !== false) {
        if (!this.options.authorization) {
          try {
            metrics?.incrementCounter('rpc.requests.total', { ...labels, outcome: 'forbidden' });
          } catch {
            // Instrumentation is best-effort.
          }
          endSpan('error', 'Authorization not configured');
          throw createMicroserviceError(
            ErrorCodes.CONFIGURATION,
            `Authorization required but not configured for ${service}.${method}`,
            'CONFIGURATION',
            false,
            { details: { service, method } }
          );
        }

        const decision = await this.options.authorization.evaluate({
          caller: (principal ?? this.options.service),
          targetService,
          operation,
          resource,
          attributes: request.attributes ?? {},
        }).catch((err) => {
          return { allowed: false, reason: err instanceof Error ? err.message : String(err) } as { allowed: boolean; reason?: string };
        });

        if (!decision.allowed) {
          try {
            await this.options.audit?.log({
              eventId: `authz-${Date.now()}`,
              eventType: AuditEventTypes.AUTHORIZATION_DENIED,
              timestamp: Date.now(),
              actor: {
                serviceId: (principal ?? this.options.service).serviceId,
                instanceId: (principal ?? this.options.service).instanceId,
              },
              action: 'call',
              resource: { type: 'method', id: `${service}.${method}` },
              outcome: 'failure',
              details: { service, method, transport, reason: decision.reason },
              riskLevel: 'high',
            });
          } catch {
            // Audit logging must not block the request path.
          }
          try {
            metrics?.incrementCounter('rpc.requests.total', { ...labels, outcome: 'forbidden' });
          } catch {
            // Instrumentation is best-effort.
          }
          endSpan('error', decision.reason ?? 'Authorization denied');
          throw createMicroserviceError(
            ErrorCodes.FORBIDDEN,
            decision.reason ?? `Authorization denied for ${service}.${method}`,
            'AUTHORIZATION',
            false,
            { details: { service, method, reason: decision.reason } }
          );
        }
      }

      // Execute handler only after checks.
      try {
        const result = await handler();
        try {
          metrics?.incrementCounter('rpc.requests.total', { ...labels, outcome: 'success' });
          metrics?.recordSummary('rpc.request.duration.ms', Date.now() - startedAt, labels);
        } catch {
          // Instrumentation is best-effort.
        }
        endSpan('ok');
        return result;
      } catch (err) {
        if (isMicroserviceError(err)) {
          try {
            metrics?.incrementCounter('rpc.requests.total', { ...labels, outcome: 'error' });
            metrics?.recordSummary('rpc.request.duration.ms', Date.now() - startedAt, labels);
          } catch {
            // Instrumentation is best-effort.
          }
          endSpan('error', err.message);
          throw err;
        }
        const wrapped = createMicroserviceError(
          ErrorCodes.INTERNAL,
          err instanceof Error ? err.message : String(err),
          'INTERNAL',
          false,
          {
            details: { service, method, transport, originalError: sanitizeErrorDetails(err) },
          },
        );
        try {
          metrics?.incrementCounter('rpc.requests.total', { ...labels, outcome: 'error' });
          metrics?.recordSummary('rpc.request.duration.ms', Date.now() - startedAt, labels);
        } catch {
          // Instrumentation is best-effort.
        }
        endSpan('error', wrapped.message);
        throw wrapped;
      }
    } catch (err) {
      if (span && !spanEnded && span.status.code === 'unset') {
        try {
          span.status = { code: 'error', message: (err as Error)?.message };
          tracer?.endSpan(span);
          spanEnded = true;
        } catch {
          // Tracing is best-effort.
        }
      }
      throw err;
    } finally {
      if (span && !spanEnded) {
        try {
          if (span.status.code === 'unset') {
            span.status = { code: 'error', message: 'unfinished' };
          }
          tracer?.endSpan(span);
        } catch {
          // Tracing is best-effort.
        } finally {
          spanEnded = true;
        }
      }
    }
  }
}

export function createSecuredDispatcher(options: SecuredDispatchOptions): SecuredDispatcher {
  return new SecuredDispatcher(options);
}

function unwrapSecuritySource(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate['options'] && typeof candidate['options'] === 'object' && (candidate as Record<string, unknown>)['registerTransport'] === undefined && (
    (candidate['options'] as Record<string, unknown>)['service'] || (candidate['options'] as Record<string, unknown>)['authorization'] || (candidate['options'] as Record<string, unknown>)['authenticator'] ||
    (candidate['options'] as Record<string, unknown>)['authenticationEnabled'] !== undefined || (candidate['options'] as Record<string, unknown>)['audit'] || (candidate['options'] as Record<string, unknown>)['tracer'] || (candidate['options'] as Record<string, unknown>)['metrics']
  )) {
    return candidate['options'] as Record<string, unknown>;
  }
  return candidate;
}

function findSecurityCandidate(...sources: unknown[]): { raw?: Record<string, unknown>; explicit: boolean } {
  let explicit = false;
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const candidates: unknown[] = [
      source,
      (source as Record<string, unknown>)['security'],
      (source as Record<string, unknown>)['server'],
      (source as Record<string, unknown>)['microserviceServer'],
      (source as Record<string, unknown>)['serverOptions'],
      (source as Record<string, unknown>)['securityOptions'],
      (source as Record<string, unknown>)['dispatcher'],
      (source as Record<string, unknown>)['securedDispatcher'],
    ];
    for (const candidate of candidates) {
      const unwrapped = unwrapSecuritySource(candidate);
      if (!unwrapped) continue;
      if (
        unwrapped['service'] || unwrapped['authorization'] || unwrapped['authenticator'] ||
        unwrapped['authenticationEnabled'] !== undefined || unwrapped['audit'] || unwrapped['tracer'] || unwrapped['metrics'] ||
        unwrapped['securedDispatcher'] || unwrapped['dispatcher'] || unwrapped['securityRequired'] === true || unwrapped['requireSecurity'] === true
      ) {
        explicit = true;
    return { raw: unwrapped, explicit };
      }
    }
  }
  return { explicit: false };
}

export interface ResolvedSecurity {
  dispatcher?: SecuredDispatcher;
  options?: SecuredDispatchOptions;
  protected: boolean;
}

export function resolveSecurity(...sources: unknown[]): ResolvedSecurity {
  const found = findSecurityCandidate(...sources) as { raw?: Record<string, unknown>; explicit: boolean };
  const raw = found['raw'] as Record<string, unknown> | undefined;
  if (!raw) {
    return { protected: false };
  }

  const providedDispatcher = raw['securedDispatcher'] ?? raw['dispatcher'];
  const dispatcher = providedDispatcher instanceof SecuredDispatcher ? providedDispatcher : undefined;

  const service = (raw['service'] as ServiceIdentity | undefined) ?? ({
    serviceId: String(raw['serviceName'] ?? 'adapter'),
    serviceName: String(raw['serviceName'] ?? 'adapter'),
    instanceId: crypto.randomUUID(),
    credentials: { type: 'api-key', apiKey: 'adapter', issuedAt: Date.now(), issuer: 'adapter' },
    getRegistration: () => ({} as never),
    sign: async () => { throw new Error('NotSupportedError'); },
    verify: async () => false,
  } as unknown as ServiceIdentity);

  const options: SecuredDispatchOptions = {
    service: service as ServiceIdentity,
    authorization: raw['authorization'] as AuthorizationPolicy | undefined,
    authenticationEnabled: raw['authenticationEnabled'] as boolean | undefined,
    audit: raw['audit'] as AuditLogger | undefined,
    authenticator: raw['authenticator'] as Authenticator | undefined,
    tracer: raw['tracer'] as Tracer | undefined,
    metrics: raw['metrics'] as MetricsCollector | undefined,
  };

  const hasSecurityConfig = !!(raw['authorization'] || raw['authenticator'] || raw['audit'] || raw['tracer'] || raw['metrics'] ||
    raw['authenticationEnabled'] !== undefined || raw['securityRequired'] === true || raw['requireSecurity'] === true ||
    dispatcher);

  const protectedFlag = hasSecurityConfig && options.authenticationEnabled !== false;

  if (dispatcher) {
    return { dispatcher, options, protected: true };
  }
  return { options, protected: protectedFlag };
}
