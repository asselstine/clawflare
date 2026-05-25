// Mock for @cloudflare/containers - used in test environment only
// This module requires cloudflare:workers which is not available in node tests

export class Container {
  defaultPort?: number;
  requiredPorts?: number[];
  sleepAfter: string | number = "5m";
  envVars: Record<string, string> = {};
  entrypoint?: string[];
  enableInternet = false;
  labels?: Record<string, string>;
  interceptHttps = false;
  allowedHosts?: string[];
  deniedHosts?: string[];
  pingEndpoint = "/";

  static outbound?: (
    request: Request,
    env: unknown,
    ctx: { containerId?: string }
  ) => Promise<Response> | Response;

  constructor() {
    // noop
  }
}

export class ContainerProxy {
  constructor() {
    // noop
  }
}

export function getContainer<T>(namespace: unknown, id: string): T {
  void namespace;
  void id;
  throw new Error("getContainer is not available in test environment");
}

export function outboundParams<T>(
  _handler: T,
  params: unknown
): unknown {
  return params;
}

export function getRandom(): number {
  return Math.random();
}

export function loadBalance(): number {
  return 0;
}

export function switchPort<T>(port: number, fn: () => T): T {
  void port;
  return fn();
}
