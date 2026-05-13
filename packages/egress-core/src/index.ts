export interface EgressContext<Env = unknown> {
  env: Env;
  handlerConfig?: unknown;
  requestId?: string;
}

export interface EgressHandler<Env = unknown> {
  name: string;
  description: string;
  domains: string[];

  handles(request: Request, context: EgressContext<Env>): boolean | Promise<boolean>;
  fetch?(request: Request, context: EgressContext<Env>): Promise<Response>;
  connect?(socket: unknown, context: EgressContext<Env>): void | Promise<void>;
}

export class EgressRegistry<Env = unknown> {
  private handlers = new Map<string, EgressHandler<Env>>();

  register(handler: EgressHandler<Env>): void {
    this.handlers.set(handler.name, handler);
  }

  get(name: string): EgressHandler<Env> | undefined {
    return this.handlers.get(name);
  }

  list(): EgressHandler<Env>[] {
    return Array.from(this.handlers.values());
  }
}

export function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}
