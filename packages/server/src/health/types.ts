export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
    status: HealthStatus;
    latency?: number;
    message?: string;
    details?: object;
}

export type HealthCheck = () => HealthCheckResult | Promise<HealthCheckResult>;

export interface HealthProvider {
    name: string;
    check: HealthCheck;
    critical?: boolean;
}

export interface HealthRegistry {
    register(provider: HealthProvider): void;
    unregister(name: string): void;
    getAll(): HealthProvider[];
    checkAll(): Promise<Record<string, HealthCheckResult>>;
}

export interface HealthRouteOptions {
    path?: string;
    serviceName?: string;
    includeDetails?: boolean;
}