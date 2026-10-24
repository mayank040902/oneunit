declare module "pg" {
  export class Pool {
    constructor(config?: Record<string, unknown>);
    query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
    end(): Promise<void>;
  }
}
