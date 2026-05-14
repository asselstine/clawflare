// State management helpers for Workflow-Agent decoupling
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentSessionState } from "./agent";
import type { DurableAgentWorkflow, WorkflowProgressEvent } from "./workflow";
import type { Env } from "./types";

export interface StateBundle {
  session: AgentSessionState;
  workflow: DurableAgentWorkflow;
}

export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function workflowKey(workflowId: string): string {
  return `workflow:${workflowId}`;
}

export async function loadSession(env: Env, sessionId: string): Promise<AgentSessionState> {
  const raw = await env.AGENT_SESSION.get(sessionKey(sessionId));
  if (!raw) throw new Error(`Session not found: ${sessionId}`);
  return JSON.parse(raw) as AgentSessionState;
}

export async function loadWorkflow(env: Env, workflowId: string): Promise<DurableAgentWorkflow> {
  const raw = await env.AGENT_SESSION.get(workflowKey(workflowId));
  if (!raw) throw new Error(`Workflow not found: ${workflowId}`);
  return JSON.parse(raw) as DurableAgentWorkflow;
}

export async function saveSession(env: Env, session: AgentSessionState): Promise<void> {
  const serialized = JSON.stringify({
    ...session,
    updatedAt: Date.now(),
  });
  await env.AGENT_SESSION.put(sessionKey(session.id), serialized);
  // Keep backward compatibility
  await env.AGENT_SESSION.put(session.id, serialized);
}

export async function saveWorkflow(env: Env, workflow: DurableAgentWorkflow): Promise<void> {
  await env.AGENT_SESSION.put(workflowKey(workflow.id), JSON.stringify(workflow));
}

export async function loadState(env: Env, sessionId: string, workflowId: string): Promise<StateBundle> {
  const [session, workflow] = await Promise.all([
    loadSession(env, sessionId),
    loadWorkflow(env, workflowId),
  ]);
  return { session, workflow };
}

export async function saveState(env: Env, bundle: StateBundle): Promise<void> {
  await Promise.all([
    saveSession(env, bundle.session),
    saveWorkflow(env, bundle.workflow),
  ]);
}

export function appendWorkflowProgress(
  workflow: DurableAgentWorkflow,
  event: Omit<WorkflowProgressEvent, "timestamp" | "sequence">,
): DurableAgentWorkflow {
  const sequence = (workflow.progress.at(-1)?.sequence ?? 0) + 1;
  return {
    ...workflow,
    progress: [...workflow.progress, { ...event, timestamp: Date.now(), sequence }].slice(-100),
  };
}

export function appendAgentEvents(
  workflow: DurableAgentWorkflow,
  events: AgentEvent[],
): DurableAgentWorkflow {
  return events.reduce(
    (nextWorkflow, event) => appendWorkflowProgress(nextWorkflow, summarizeAgentEvent(event)),
    workflow,
  );
}

function summarizeAgentEvent(event: AgentEvent): Omit<WorkflowProgressEvent, "timestamp" | "sequence"> {
  const type = event.type.startsWith("tool_")
    ? "tool"
    : event.type.startsWith("message_")
      ? "message"
      : event.type.startsWith("turn_")
        ? "turn"
        : event.type.startsWith("agent_")
          ? "agent"
          : "workflow";

  return { type, summary: agentEventSummary(event), event };
}

function agentEventSummary(event: AgentEvent): string {
  switch (event.type) {
    case "agent_start":
      return "Agent run started";
    case "agent_end":
      return "Agent run completed";
    case "turn_start":
      return "Turn started";
    case "turn_end":
      return "Turn completed";
    case "message_start":
      return `${event.message.role} message started`;
    case "message_update":
      return `${event.message.role} message updated`;
    case "message_end":
      return `${event.message.role} message recorded`;
    case "tool_execution_start":
      return `Running ${event.toolName}`;
    case "tool_execution_update":
      return `${event.toolName} updated`;
    case "tool_execution_end":
      return `${event.toolName} ${event.isError ? "failed" : "completed"}`;
  }
}
