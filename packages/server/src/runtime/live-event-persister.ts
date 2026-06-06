import type { AgentEvent } from "@earendil-works/pi-agent-core";

export const LIVE_EVENT_UPDATE_FLUSH_THRESHOLD = 10;
export const LIVE_EVENT_UPDATE_FLUSH_INTERVAL_MS = 120;

type AppendAgentEvents = (events: AgentEvent[]) => Promise<void>;

function getLiveUpdateKey(event: AgentEvent): string | undefined {
  if (event.type === "message_update") return "message_update";
  return undefined;
}

export class LiveAgentEventPersister {
  private readonly handledEvents = new Set<AgentEvent>();
  private readonly pendingUpdates = new Map<string, AgentEvent>();
  private pendingUpdateCount = 0;
  private lastUpdateFlushAt = Date.now();

  constructor(
    private readonly appendEvents: AppendAgentEvents,
    private readonly updateFlushThreshold = LIVE_EVENT_UPDATE_FLUSH_THRESHOLD,
    private readonly updateFlushIntervalMs = LIVE_EVENT_UPDATE_FLUSH_INTERVAL_MS,
  ) {}

  hasHandled(event: AgentEvent): boolean {
    return this.handledEvents.has(event);
  }

  async onEvent(event: AgentEvent): Promise<void> {
    this.handledEvents.add(event);

    const updateKey = getLiveUpdateKey(event);
    if (updateKey) {
      this.pendingUpdates.set(updateKey, event);
      this.pendingUpdateCount += 1;
      const elapsedSinceFlush = Date.now() - this.lastUpdateFlushAt;

      if (this.pendingUpdateCount >= this.updateFlushThreshold || elapsedSinceFlush >= this.updateFlushIntervalMs) {
        await this.flushUpdates();
      }
      return;
    }

    await this.flushUpdates();
    await this.appendEvents([event]);
  }

  async flushUpdates(): Promise<void> {
    if (this.pendingUpdates.size === 0) return;

    const events = [...this.pendingUpdates.values()];
    this.pendingUpdates.clear();
    this.pendingUpdateCount = 0;
    this.lastUpdateFlushAt = Date.now();
    await this.appendEvents(events);
  }
}
