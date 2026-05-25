// Internal event types - storage-safe event representations
// These are used for persistence and runtime adaptation

import type { AgentEvent } from "@earendil-works/pi-agent-core";

// Re-export for internal convenience
export type { SessionEvent } from "../types.js";

/**
 * Base stored event with common fields
 */
export interface StoredEventBase {
  sequence: number;
  timestamp: number;
}

/**
 * Stored message event - compact representation for persistence
 */
export interface StoredMessageEvent extends StoredEventBase {
  type: "message";
  messageId: string;
  messageRole: "user" | "assistant" | "toolResult";
  content: string; // Compact text representation
}

/**
 * Stored event lifecycle events
 */
export interface StoredLifecycleEvent extends StoredEventBase {
  type: "agent_start" | "agent_end";
}

/**
 * Stored tool execution event
 */
export interface StoredToolStartEvent extends StoredEventBase {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
}

/**
 * Stored tool execution update event
 */
export interface StoredToolUpdateEvent extends StoredEventBase {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  status: "running" | "complete" | "error";
}

/**
 * Stored tool end event
 */
export interface StoredToolEndEvent extends StoredEventBase {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
}

/**
 * Stored error event
 */
export interface StoredErrorEvent extends StoredEventBase {
  type: "error";
  message: string;
}

/**
 * Union of all stored event types
 */
export type StoredSessionEvent =
  | StoredMessageEvent
  | StoredLifecycleEvent
  | StoredToolStartEvent
  | StoredToolUpdateEvent
  | StoredToolEndEvent
  | StoredErrorEvent;

/**
 * NewSessionEvent - AgentEvent with timestamp before sequence assignment
 */
export type NewSessionEvent = AgentEvent & { timestamp: number };

/**
 * Store event key for a sequence number
 */
export function eventKey(sequence: number): string {
  return `evt/${sequence}`;
}

/**
 * Message key for a sequence number
 */
export function messageKey(sequence: number): string {
  return `msg/${sequence}`;
}
