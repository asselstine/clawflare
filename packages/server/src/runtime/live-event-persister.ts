import type { AgentEvent } from "@earendil-works/pi-agent-core";

export const LIVE_EVENT_UPDATE_FLUSH_THRESHOLD = 10;

type AppendAgentEvents = (events: AgentEvent[]) => Promise<void>;

function getLiveUpdateKey(event: AgentEvent): string | undefined {
  if (event.type === "message_update") return "message_update";
  if (event.type === "tool_execution_update") return `tool_execution_update:${event.toolCallId}`;
  return undefined;
}

export class LiveAgentEventPersister {
  private readonly handledEvents = new Set<AgentEvent>();
  private readonly pendingUpdates = new Map<string, AgentEvent>();
  private pendingUpdateCount = 0;

  constructor(
    private readonly appendEvents: AppendAgentEvents,
    private readonly updateFlushThreshold = LIVE_EVENT_UPDATE_FLUSH_THRESHOLD,
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

      if (this.pendingUpdateCount >= this.updateFlushThreshold) {
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
    await this.appendEvents(events);
  }
}
