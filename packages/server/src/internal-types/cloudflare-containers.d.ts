declare module "@cloudflare/containers" {
  export class Container<Env = unknown> extends CloudflareWorkersModule.DurableObject<Env> {
    static outbound?: (
      request: Request,
      env: Env,
      ctx: { containerId?: string; params?: unknown }
    ) => Promise<Response> | Response;
    static outboundHandlers?: Record<
      string,
      (
        request: Request,
        env: Env,
        ctx: { containerId?: string; params?: unknown }
      ) => Promise<Response> | Response
    >;

    defaultPort?: number;
    requiredPorts?: number[];
    sleepAfter?: string | number;
    envVars?: Record<string, string>;
    entrypoint?: string[];
    enableInternet?: boolean;
    labels?: Record<string, string>;
    interceptHttps?: boolean;
    allowedHosts?: string[];
    deniedHosts?: string[];
    pingEndpoint?: string;
    startAndWaitForPorts(options: {
      ports: number[];
      startOptions?: { enableInternet?: boolean };
      cancellationOptions?: { portReadyTimeoutMS?: number; abort?: AbortSignal };
    }): Promise<void>;
    setOutboundHandler(name: string, params?: unknown): Promise<void>;
    containerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    destroy(): Promise<void>;
  }

  export class ContainerProxy {}
  export function getContainer<T extends DurableObjectBranded>(
    namespace: DurableObjectNamespace<T>,
    id: string
  ): T;
  export function outboundParams<T>(handler: T, params: unknown): unknown;
  export function getRandom(): number;
  export function loadBalance(): number;
  export function switchPort<T>(port: number, fn: () => T): T;
}
