#!/usr/bin/env node

import readline from "node:readline";

const keyGaps = [
  {
    label: "Chat route to workflow wake",
    from: "chat.route.start",
    to: "chat.workflow.woke",
    note: "Large gap suggests request parse, session lookup, enqueue, workflow create, or wake overhead before async execution begins.",
  },
  {
    label: "New session model resolve",
    from: "chat.auth.context_created",
    to: "chat.model.resolved",
    note: "Large gap suggests model connection lookup or Secret Broker/provider credential resolution overhead.",
  },
  {
    label: "Session poll event query",
    from: "session.poll.start",
    to: "session.poll.events_loaded",
    note: "Large gap suggests session lookup or event cursor query overhead on polling.",
  },
  {
    label: "Session poll message snapshot",
    from: "session.poll.messages_decided",
    to: "session.poll.messages_loaded",
    note: "Large gap suggests full workflow snapshot load overhead during polling.",
  },
  {
    label: "Session poll response",
    from: "session.poll.start",
    to: "session.poll.response",
    note: "Large gap suggests poll response assembly or serialization overhead.",
  },
  {
    label: "Workflow startup",
    from: "workflow.run.start",
    to: "workflow.mark_active.done",
    note: "Large gap suggests workflow initialization or D1 runtime activation delay.",
  },
  {
    label: "Input dequeue",
    from: "workflow.mark_active.done",
    to: "workflow.input.dequeued",
    note: "Large gap suggests queue access or workflow wake delay before input is visible.",
  },
  {
    label: "Prompt enqueue",
    from: "workflow.prompt.start",
    to: "workflow.prompt.enqueued",
    note: "Large gap suggests session load, agent context setup, or prompt enqueue overhead.",
  },
  {
    label: "Agent step setup",
    from: "workflow.agent_step.start",
    to: "workflow.agent.created",
    note: "Large gap suggests model/secret/tool setup before the step can run.",
  },
  {
    label: "Provider stream creation",
    from: "agent.assistant.stream.create.start",
    to: "agent.assistant.stream.created",
    note: "Large gap suggests provider request setup latency.",
  },
  {
    label: "Provider first event",
    from: "agent.assistant.stream.created",
    to: "agent.assistant.stream.first_event",
    note: "Large gap suggests provider/model first-token latency.",
  },
  {
    label: "Session save",
    from: "workflow.agent_step.ran",
    to: "workflow.session.saved",
    note: "Large gap suggests full snapshot serialization or D1 write overhead.",
  },
  {
    label: "Prompt finalize",
    from: "workflow.prompt.finalizing",
    to: "workflow.prompt.finalized",
    note: "Large gap suggests final metadata/cursor persistence overhead.",
  },
];

const legacyKeyGaps = [
  {
    label: "Legacy workflow scheduling/start",
    from: "chat.workflow.create.returned",
    to: "workflow.run.start",
    note: "Large gap suggests delay before Workflow.run begins.",
  },
  {
    label: "Workflow initialization",
    from: "workflow.run.start",
    to: "workflow.initialize.done",
    note: "Large gap suggests Durable Object/component initialization delay.",
  },
  {
    label: "Pre-provider agent setup",
    from: "workflow.step_do.start",
    to: "assistant.stream.created",
    note: "Large gap suggests agent setup before provider stream creation.",
  },
  {
    label: "Provider first event",
    from: "assistant.stream.created",
    to: "assistant.stream.first_event",
    note: "Large gap suggests provider/model first-token latency.",
  },
  {
    label: "Buffered assistant step",
    from: "assistant.stream.first_event",
    to: "workflow.execute_step.events_appended",
    note: "Large gap suggests events are produced but not persisted until step completion.",
  },
  {
    label: "Poll visibility",
    from: "workflow.execute_step.events_appended",
    to: "session.poll",
    note: "Large gap suggests polling/storage visibility delay after events are appended.",
  },
];

const args = process.argv.slice(2);
const sessionFilter = getArgValue("--session");
const showAll = args.includes("--all");
const sessions = new Map();

function getArgValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseTimingLog(line) {
  const jsonStart = line.indexOf("{");
  if (jsonStart === -1) return undefined;

  try {
    const parsed = JSON.parse(line.slice(jsonStart));
    if (parsed?.source !== "clawflare-timing" || typeof parsed.phase !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function addEvent(event) {
  const sessionId = event.sessionId || "unknown";
  if (sessionFilter && sessionId !== sessionFilter) return;

  const sessionEvents = sessions.get(sessionId) ?? [];
  sessionEvents.push(event);
  sessions.set(sessionId, sessionEvents);
}

function findGap(events, from, to) {
  const fromEvent = events.find((event) => event.phase === from);
  if (!fromEvent) return undefined;

  const toEvent = events.find((event) => event.phase === to && event.at >= fromEvent.at);
  if (!toEvent) return undefined;

  return { fromEvent, toEvent, durationMs: toEvent.at - fromEvent.at };
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printSession(sessionId, events) {
  const sorted = events
    .filter((event) => typeof event.at === "number")
    .sort((a, b) => a.at - b.at);

  if (sorted.length === 0) return;

  const start = sorted[0].at;
  const end = sorted.at(-1).at;

  console.log(`\nSession ${sessionId}`);
  console.log(`Total observed timing span: ${formatMs(end - start)} (${sorted.length} timing logs)`);

  console.log("\nKey gaps:");
  for (const gapDef of keyGaps) {
    const gap = findGap(sorted, gapDef.from, gapDef.to);
    if (!gap) {
      console.log(`  - ${gapDef.label}: missing ${gapDef.from} -> ${gapDef.to}`);
      continue;
    }

    const marker = gap.durationMs >= 10_000 ? " ⚠" : gap.durationMs >= 3_000 ? " ◔" : "";
    console.log(`  - ${gapDef.label}: ${formatMs(gap.durationMs)}${marker}`);
    if (gap.durationMs >= 3_000) {
      console.log(`    ${gapDef.note}`);
    }
  }

  const hasLegacyEvents = legacyKeyGaps.some((gapDef) =>
    sorted.some((event) => event.phase === gapDef.from || event.phase === gapDef.to)
  );
  if (hasLegacyEvents) {
    console.log("\nLegacy key gaps:");
    for (const gapDef of legacyKeyGaps) {
      const gap = findGap(sorted, gapDef.from, gapDef.to);
      if (!gap) {
        console.log(`  - ${gapDef.label}: missing ${gapDef.from} -> ${gapDef.to}`);
        continue;
      }

      const marker = gap.durationMs >= 10_000 ? " ⚠" : gap.durationMs >= 3_000 ? " ◔" : "";
      console.log(`  - ${gapDef.label}: ${formatMs(gap.durationMs)}${marker}`);
      if (gap.durationMs >= 3_000) {
        console.log(`    ${gapDef.note}`);
      }
    }
  }

  const exceptions = sorted.filter((event) => event.phase.includes("exception"));
  if (exceptions.length > 0) {
    console.log("\nExceptions:");
    for (const event of exceptions) {
      console.log(`  - +${formatMs(event.at - start)} ${event.phase}: ${event.error ?? "unknown error"}`);
    }
  }

  if (showAll) {
    console.log("\nTimeline:");
    for (const event of sorted) {
      const elapsed = `+${formatMs(event.at - start)}`.padStart(9);
      const ownElapsed = event.elapsedMs === undefined ? "" : ` elapsed=${formatMs(event.elapsedMs)}`;
      console.log(`  ${elapsed} ${event.phase}${ownElapsed}`);
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const event = parseTimingLog(line);
  if (event) addEvent(event);
});

rl.on("close", () => {
  if (sessions.size === 0) {
    console.error("No clawflare timing logs found on stdin.");
    console.error("Enable CLAWFLARE_DEBUG_TIMING=1 and pipe wrangler tail output into this script.");
    process.exitCode = 1;
    return;
  }

  for (const [sessionId, events] of sessions) {
    printSession(sessionId, events);
  }
});
