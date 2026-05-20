import { DurableObject } from "cloudflare:workers";
import type { Env, StoredCodeEntry, EgressHandlerMetadata, Datastore } from "./internal-types/index.js";

const CODE_PREFIX = "code:";
const EGRESS_PREFIX = "egress:";

/**
 * Get a datastore client for the given environment
 */
export function getDatastore(env: Env): Datastore {
  const id = env.DATASTORE.idFromName("default");
  const stub = env.DATASTORE.get(id);
  return new DatastoreClient(stub);
}

export class ClawflareDatastore extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, "");

    if (request.method === "POST" && path === "store-code") {
      return this.storeCode(request);
    }
    if (request.method === "GET" && path === "get-code") {
      const name = url.searchParams.get("name");
      if (!name) return new Response(JSON.stringify({ error: "name required" }), { status: 400 });
      return this.getCode(name);
    }
    if (request.method === "GET" && path === "list-code") {
      return this.listCode();
    }
    if (request.method === "POST" && path === "store-egress") {
      return this.storeEgress(request);
    }
    if (request.method === "GET" && path === "get-egress") {
      const name = url.searchParams.get("name");
      if (!name) return new Response(JSON.stringify({ error: "name required" }), { status: 400 });
      return this.getEgress(name);
    }
    if (request.method === "GET" && path === "list-egress") {
      return this.listEgress();
    }
    if (request.method === "GET" && path === "search") {
      const query = url.searchParams.get("q") || "";
      return this.search(query);
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

  private async storeCode(request: Request): Promise<Response> {
    const body = await request.json<{ name: string; code: string; description?: string; tags?: string[] }>();
    const entry: StoredCodeEntry = {
      name: body.name,
      code: body.code,
      description: body.description,
      tags: body.tags,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(`${CODE_PREFIX}${body.name}`, entry);
    return new Response(JSON.stringify({ ok: true }));
  }

  private async getCode(name: string): Promise<Response> {
    const entry = await this.ctx.storage.get<StoredCodeEntry>(`${CODE_PREFIX}${name}`);
    if (!entry) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    return new Response(JSON.stringify(entry));
  }

  private async listCode(): Promise<Response> {
    const list = await this.ctx.storage.list<StoredCodeEntry>({ prefix: CODE_PREFIX });
    const entries = Array.from(list.values());
    return new Response(JSON.stringify({ entries }));
  }

  private async storeEgress(request: Request): Promise<Response> {
    const body = await request.json<EgressHandlerMetadata>();
    await this.ctx.storage.put(`${EGRESS_PREFIX}${body.name}`, body);
    return new Response(JSON.stringify({ ok: true }));
  }

  private async getEgress(name: string): Promise<Response> {
    const entry = await this.ctx.storage.get<EgressHandlerMetadata>(`${EGRESS_PREFIX}${name}`);
    if (!entry) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    return new Response(JSON.stringify(entry));
  }

  private async listEgress(): Promise<Response> {
    const list = await this.ctx.storage.list<EgressHandlerMetadata>({ prefix: EGRESS_PREFIX });
    const entries = Array.from(list.values());
    return new Response(JSON.stringify({ entries }));
  }

  private async search(query: string): Promise<Response> {
    const codeList = await this.ctx.storage.list<StoredCodeEntry>({ prefix: CODE_PREFIX });
    const egressList = await this.ctx.storage.list<EgressHandlerMetadata>({ prefix: EGRESS_PREFIX });

    const q = query.toLowerCase();
    const results: unknown[] = [];

    for (const [_key, entry] of codeList) {
      if (entry.name.toLowerCase().includes(q) ||
          entry.description?.toLowerCase().includes(q) ||
          entry.tags?.some(t => t.toLowerCase().includes(q))) {
        results.push({ type: "code", ...entry });
      }
    }

    for (const [_key, entry] of egressList) {
      if (entry.name.toLowerCase().includes(q) ||
          entry.description.toLowerCase().includes(q) ||
          entry.domains.some(d => d.toLowerCase().includes(q))) {
        results.push({ type: "egress", ...entry });
      }
    }

    return new Response(JSON.stringify({ results }));
  }
}

/**
 * Client for datastore operations
 */
class DatastoreClient implements Datastore {
  constructor(private stub: DurableObjectStub) {}

  async upsertStoredCode(entry: { name: string; code: string; description?: string; tags?: string[] }): Promise<void> {
    await this.stub.fetch("https://datastore/store-code", {
      method: "POST",
      body: JSON.stringify(entry),
    });
  }

  async getStoredCode(name: string): Promise<{ name: string; code: string; description?: string; tags?: string[]; createdAt: number; updatedAt: number } | null> {
    const response = await this.stub.fetch(`https://datastore/get-code?name=${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Failed to get code: ${response.status}`);
    return response.json();
  }

  async listEgressHandlers(enabledOnly: boolean): Promise<{ name: string; description: string; domains: string[]; enabled: boolean; config: unknown }[]> {
    const response = await this.stub.fetch("https://datastore/list-egress");
    if (!response.ok) throw new Error(`Failed to list egress handlers: ${response.status}`);
    const data = await response.json() as { entries: { name: string; description: string; domains: string[]; enabled?: boolean; config?: unknown }[] };
    return data.entries.map(e => ({
      name: e.name,
      description: e.description,
      domains: e.domains,
      enabled: enabledOnly ? (e.enabled ?? true) : (e.enabled ?? true),
      config: e.config ?? {},
    }));
  }

  async search(collection: string, query: string, limit: number): Promise<{
    storedCode: { name: string; code: string; description?: string; tags?: string[]; createdAt: number; updatedAt: number }[];
    egressHandlers: { name: string; description: string; domains: string[]; enabled: boolean; config: unknown }[];
  }> {
    const response = await this.stub.fetch(`https://datastore/search?q=${encodeURIComponent(query)}&collection=${encodeURIComponent(collection)}&limit=${limit}`);
    if (!response.ok) throw new Error(`Failed to search: ${response.status}`);
    const data = await response.json() as { results: unknown[] };
    const storedCode: { name: string; code: string; description?: string; tags?: string[]; createdAt: number; updatedAt: number }[] = [];
    const egressHandlers: { name: string; description: string; domains: string[]; enabled: boolean; config: unknown }[] = [];
    for (const item of data.results) {
      const typed = item as { type: string; name: string };
      if (typed.type === "code") {
        storedCode.push(item as typeof storedCode[number]);
      } else if (typed.type === "egress") {
        egressHandlers.push({
          name: (item as { name: string }).name,
          description: (item as { description?: string }).description ?? "",
          domains: (item as { domains: string[] }).domains,
          enabled: (item as { enabled?: boolean }).enabled ?? true,
          config: (item as { config?: unknown }).config ?? {},
        });
      }
    }
    return { storedCode, egressHandlers };
  }
}
