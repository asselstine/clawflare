#!/usr/bin/env node

import readline from "node:readline";

const keyGaps = [
  {
    label: "Existing chat route to workflow input",
    from: "chat.route.start",
    to: "chat.workflow.input_sent",
    note: "Large gap suggests request parse, session lookup, session status save, or Workflow event send overhead before async execution resumes.",
  },
  {
    label: "New chat route to workflow create",
    from: "chat.route.start",
    to: "chat.workflow.created",
    note: "Large gap suggests request parse, model resolution, session creation, tool seeding, or Workflow creation overhead before async execution begins.",
  },
  {
    label: "Workflow input to prompt start",
    from: "workflow.run.start",
    to: "workflow.prompt.start",
    note: "Large gap suggests Workflow startup, active marker write, or event delivery overhead before prompt processing begins.",
  },
  {
    label: "New session model resolve",
    from: "chat.auth.context_created",
    to: "chat.model.resolved",
    note: "Large gap suggests model lookup or Secret Broker/provider credential resolution overhead.",
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
    label: "Input received",
    from: "workflow.mark_active.done",
    to: "workflow.input.received",
    note: "Large gap suggests Workflow event delivery overhead before input is visible.",
  },
  {
    label: "Prompt enqueue",
    from: "workflow.prompt.start",
    to: "workflow.prompt.enqueued",
    note: "Large gap suggests session load, agent context setup, or prompt enqueue overhead.",
  },
  {
    label: "Model context lookup",
    from: "workflow.prompt.start",
    to: "workflow.agent_context.model_resolved",
    note: "Large gap suggests model or secret resolution overhead inside the workflow.",
  },
  {
    label: "Agent components build",
    from: "workflow.agent_context.model_resolved",
    to: "workflow.agent_context.components_built",
    note: "Large gap suggests provider component construction overhead.",
  },
  {
    label: "Tool catalog load",
    from: "workflow.agent_context.created",
    to: "workflow.agent.created",
    note: "Large gap suggests session tool loading or tool runtime setup overhead.",
  },
  {
    label: "Session snapshot load",
    from: "workflow.agent.created",
    to: "workflow.session.loaded",
    note: "Large gap suggests D1 runtime snapshot load or deserialization overhead.",
  },
  {
    label: "Turn creation",
    from: "workflow.session.loaded",
    to: "workflow.prompt.enqueued",
    note: "Large gap here would be surprising; prompt enqueue itself should be CPU-local and cheap.",
  },
  {
    label: "Prompt snapshot save",
    from: "workflow.prompt.enqueued",
    to: "workflow.session.saved",
    note: "Large gap suggests full workflow snapshot serialization or D1 write overhead before events are appended.",
  },
  {
    label: "Turn start persisted",
    from: "workflow.prompt.enqueued",
    to: "workflow.prompt.events_appended",
    note: "Large gap suggests D1 event append overhead; this is when the user message and turn_start become visible to the client.",
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
  {
    label: "Finalize metadata cursor lookup",
    from: "workflow.metadata.workflow_id_loaded",
    to: "workflow.metadata.cursor_loaded",
    note: "Large gap suggests event cursor lookup overhead while finalizing the session.",
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
const liveQuietMs = Number(getArgValue("--live-quiet-ms") ?? 1500);
const sessions = new Map();
const printedEventCounts = new Map();
let printTimer;
let pendingJsonLines = [];
let pendingJsonBalance = 0;

function getArgValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isTimingEvent(value) {
  return value?.source === "clawflare-timing" && typeof value.phase === "string";
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractTimingEvents(value, events = []) {
  if (isTimingEvent(value)) {
    events.push(value);
    return events;
  }

  if (typeof value === "string") {
    const jsonStart = value.indexOf("{");
    if (jsonStart === -1) return events;
    const parsed = safeParseJson(value.slice(jsonStart));
    if (parsed !== undefined) {
      extractTimingEvents(parsed, events);
    }
    return events;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractTimingEvents(item, events);
    }
    return events;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      extractTimingEvents(item, events);
    }
  }

  return events;
}

function jsonBraceDelta(line) {
  let delta = 0;
  let inString = false;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;
    if (char === "{") delta += 1;
    if (char === "}") delta -= 1;
  }

  return delta;
}

function parseTimingLogs(line) {
  const rawParsed = safeParseJson(line.slice(Math.max(0, line.indexOf("{"))));
  const rawEvents = extractTimingEvents(rawParsed);
  if (rawEvents.length > 0) return rawEvents;

  if (pendingJsonLines.length === 0 && !line.includes("{")) {
    return [];
  }

  pendingJsonLines.push(line);
  pendingJsonBalance += jsonBraceDelta(line);

  if (pendingJsonBalance > 0) {
    return [];
  }

  const text = pendingJsonLines.join("\n");
  pendingJsonLines = [];
  pendingJsonBalance = 0;

  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return [];

  return extractTimingEvents(safeParseJson(text.slice(jsonStart)));
}

function addEvent(event) {
  const sessionId = event.sessionId || "unknown";
  if (sessionFilter && sessionId !== sessionFilter) return;

  const sessionEvents = sessions.get(sessionId) ?? [];
  sessionEvents.push(event);
  sessions.set(sessionId, sessionEvents);
  scheduleLivePrint();
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

function printPendingSessions() {
  let printed = false;
  for (const [sessionId, events] of sessions) {
    const alreadyPrinted = printedEventCounts.get(sessionId) ?? 0;
    if (events.length === alreadyPrinted) continue;

    printSession(sessionId, events);
    printedEventCounts.set(sessionId, events.length);
    printed = true;
  }

  if (printed) {
    console.log("\nWaiting for more timing logs...");
  }
}

function scheduleLivePrint() {
  if (!Number.isFinite(liveQuietMs) || liveQuietMs < 0) return;
  if (printTimer) clearTimeout(printTimer);
  printTimer = setTimeout(() => {
    printTimer = undefined;
    printPendingSessions();
  }, liveQuietMs);
  printTimer.unref?.();
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  for (const event of parseTimingLogs(line)) {
    addEvent(event);
  }
});

rl.on("close", () => {
  if (printTimer) {
    clearTimeout(printTimer);
    printTimer = undefined;
  }

  if (sessions.size === 0) {
    console.error("No clawflare timing logs found on stdin.");
    console.error("Enable CLAWFLARE_DEBUG_TIMING=1 and pipe wrangler tail output into this script.");
    process.exitCode = 1;
    return;
  }

  printPendingSessions();
});
