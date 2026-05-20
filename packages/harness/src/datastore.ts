// Datastore - backed by D1
// Provides stored code and egress handler management via the D1 data layer

import type {
  Env,
  Datastore,
} from "./internal-types/index.js";
import { createDataLayer } from "./data/index.js";

// Cached data layer per environment
const dataLayerCache = new WeakMap<Env, ReturnType<typeof createDataLayer>>();

function getDataLayer(env: Env) {
  let layer = dataLayerCache.get(env);
  if (!layer) {
    layer = createDataLayer(env);
    dataLayerCache.set(env, layer);
  }
  return layer;
}

/**
 * Get a datastore client for the given environment
 * Returns a D1-backed implementation
 */
export function getDatastore(env: Env): Datastore {
  return new D1DatastoreClient(env);
}

/**
 * D1-backed datastore client
 */
class D1DatastoreClient implements Datastore {
  constructor(private env: Env) {}

  async upsertStoredCode(entry: {
    name: string;
    code: string;
    description?: string;
    tags?: string[];
  }): Promise<void> {
    await getDataLayer(this.env).storedCode.upsert(entry);
  }

  async getStoredCode(
    name: string
  ): Promise<{
    name: string;
    code: string;
    description?: string;
    tags?: string[];
    createdAt: number;
    updatedAt: number;
  } | null> {
    return getDataLayer(this.env).storedCode.get(name);
  }

  async listEgressHandlers(
    enabledOnly: boolean
  ): Promise<
    {
      name: string;
      description: string;
      domains: string[];
      enabled: boolean;
      config: unknown;
    }[]
  > {
    return getDataLayer(this.env).egressHandlers.list(enabledOnly);
  }

  async search(
    _collection: string,
    query: string,
    limit: number
  ): Promise<{
    storedCode: {
      name: string;
      code: string;
      description?: string;
      tags?: string[];
      createdAt: number;
      updatedAt: number;
    }[];
    egressHandlers: {
      name: string;
      description: string;
      domains: string[];
      enabled: boolean;
      config: unknown;
    }[];
  }> {
    return getDataLayer(this.env).search(query, limit);
  }
}
