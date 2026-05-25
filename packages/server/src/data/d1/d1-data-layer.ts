// D1 Data Layer Factory
// Creates a complete DataLayer backed by Cloudflare D1

import type { DataLayer, SearchResults } from "../interfaces.js";
import { D1SessionRepository } from "./d1-sessions.js";
import { D1SessionEventRepository } from "./d1-session-events.js";
import { D1InputQueueRepository } from "./d1-input-queue.js";
import { D1SessionRuntimeRepository } from "./d1-runtime-state.js";
import { D1StoredCodeRepository } from "./d1-stored-code.js";
import { D1EgressHandlerRepository } from "./d1-egress-handlers.js";
import { D1SnapshotRepository } from "./d1-snapshots.js";

/**
 * Create a DataLayer backed by D1
 */
export function createD1DataLayer(db: D1Database): DataLayer {
  const storedCode = new D1StoredCodeRepository(db);
  const egressHandlers = new D1EgressHandlerRepository(db);

  return {
    sessions: new D1SessionRepository(db),
    events: new D1SessionEventRepository(db),
    inputQueue: new D1InputQueueRepository(db),
    runtime: new D1SessionRuntimeRepository(db),
    storedCode,
    egressHandlers,
    snapshots: new D1SnapshotRepository(db),

    async search(query: string, limit: number): Promise<SearchResults> {
      const [storedCodeResults, egressResults] = await Promise.all([
        storedCode.search(query, limit),
        egressHandlers.search(query, limit),
      ]);

      return {
        storedCode: storedCodeResults,
        egressHandlers: egressResults,
      };
    },
  };
}

/**
 * Re-export repository classes for testing
 */
export {
  D1SessionRepository,
  D1SessionEventRepository,
  D1InputQueueRepository,
  D1SessionRuntimeRepository,
  D1StoredCodeRepository,
  D1EgressHandlerRepository,
  D1SnapshotRepository,
};
