/**
 * Container Client - Worker-side RPC client for the container runtime server
 */

import type { Env } from "../internal-types/index.js";

// Container fetch result types
export interface ContainerRuntimeResponse {
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// Container API response types
export interface BashResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  killed: boolean;
  output?: string;
  error?: string;
  [key: string]: unknown;
}

export interface ReadResult {
  ok: boolean;
  content: string;
  path: string;
  totalLines: number;
  size: number;
  [key: string]: unknown;
}

export interface WriteResult {
  ok: boolean;
  path: string;
  bytesWritten: number;
  totalSize: number;
  appended: boolean;
  [key: string]: unknown;
}

export interface EditResult {
  ok: boolean;
  path: string;
  replacements: number;
  oldString: string;
  newString: string;
  [key: string]: unknown;
}

interface Match {
  path: string;
  line: number;
  text: string;
}

export interface GrepResult {
  ok: boolean;
  pattern: string;
  path: string;
  matches: Match[];
  matchCount: number;
  truncated: boolean;
  [key: string]: unknown;
}

interface FileResult {
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: string | null;
}

export interface FindResult {
  ok: boolean;
  path: string;
  results: FileResult[];
  resultCount: number;
  truncated: boolean;
  [key: string]: unknown;
}

interface DirEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size: number;
  mode: string | null;
  mtime: string | null;
  depth: number;
}

export interface LsResult {
  ok: boolean;
  path: string;
  entries: DirEntry[];
  entryCount: number;
  truncated: boolean;
  [key: string]: unknown;
}

export interface HealthResult {
  ok: boolean;
  status: string;
  workspace: string;
  [key: string]: unknown;
}

// Durable Object stub interface for container
interface ContainerStub {
  startAndWaitForPorts(options: {
    ports: number[];
    startOptions: { enableInternet: boolean };
    cancellationOptions: { portReadyTimeoutMS: number; abort?: AbortSignal };
  }): Promise<void>;
  containerFetch(url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }): Promise<Response>;
}

// Get container stub from Durable Object namespace
function getContainerStub(env: Env, id: string): ContainerStub {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const codingContainer = (env as unknown as Record<string, unknown>).CODING_CONTAINER as DurableObjectNamespace | undefined;
  if (!codingContainer) {
    throw new Error("CODING_CONTAINER binding not available");
  }
  
  const durableObjectId = codingContainer.idFromName(id);
  return codingContainer.get(durableObjectId) as unknown as ContainerStub;
}

// Default timeout for container operations
const DEFAULT_CONTAINER_TIMEOUT = 30000;
const MAX_CONTAINER_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Call the container runtime server
 */
export async function callContainerRuntime(
  env: Env,
  containerId: string,
  endpoint: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<ContainerRuntimeResponse> {
  const container = getContainerStub(env, containerId);
  
  // Start container and wait for port
  await container.startAndWaitForPorts({
    ports: [8080],
    startOptions: { enableInternet: false },
    cancellationOptions: { portReadyTimeoutMS: DEFAULT_CONTAINER_TIMEOUT, abort: signal },
  });
  
  const response = await container.containerFetch(`http://localhost${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  
  const payload = (await response.json()) as ContainerRuntimeResponse;
  
  if (!response.ok || payload?.ok === false) {
    const errorMsg = payload?.error as string | undefined || 
      `Container runtime call failed: ${response.status}`;
    throw new Error(errorMsg);
  }
  
  return payload;
}

/**
 * Check if container is healthy
 */
export async function getContainerHealth(
  env: Env,
  containerId: string,
  signal?: AbortSignal
): Promise<HealthResult> {
  const container = getContainerStub(env, containerId);
  
  await container.startAndWaitForPorts({
    ports: [8080],
    startOptions: { enableInternet: false },
    cancellationOptions: { portReadyTimeoutMS: DEFAULT_CONTAINER_TIMEOUT, abort: signal },
  });
  
  const response = await container.containerFetch("http://localhost/health", {
    method: "GET",
    headers: {},
    body: "",
    signal,
  });
  
  const payload = (await response.json()) as HealthResult;
  
  if (!response.ok) {
    throw new Error(`Container health check failed: ${response.status}`);
  }
  
  return payload;
}

// Container operation wrapper functions

export async function containerBash(
  env: Env,
  containerId: string,
  command: string,
  cwd?: string,
  timeoutMs?: number,
  maxOutputChars?: number,
  signal?: AbortSignal
): Promise<BashResult> {
  const effectiveTimeout = Math.min(
    Math.max(1000, timeoutMs || DEFAULT_CONTAINER_TIMEOUT),
    MAX_CONTAINER_TIMEOUT
  );
  
  const result = await callContainerRuntime(
    env, 
    containerId, 
    "/bash", 
    {
      command,
      cwd: cwd || ".",
      timeoutMs: effectiveTimeout,
      maxOutputChars: maxOutputChars || 8000,
    },
    signal
  );
  
  return result as BashResult;
}

export async function containerRead(
  env: Env,
  containerId: string,
  path: string,
  startLine?: number,
  endLine?: number,
  maxBytes?: number,
  signal?: AbortSignal
): Promise<ReadResult> {
  const result = await callContainerRuntime(
    env,
    containerId,
    "/read",
    {
      path,
      startLine,
      endLine,
      maxBytes: maxBytes || 200000,
    },
    signal
  );
  
  return result as ReadResult;
}

export async function containerWrite(
  env: Env,
  containerId: string,
  path: string,
  content: string,
  append?: boolean,
  makeDirs?: boolean,
  signal?: AbortSignal
): Promise<WriteResult> {
  const result = await callContainerRuntime(
    env,
    containerId,
    "/write",
    {
      path,
      content,
      append: append || false,
      makeDirs: makeDirs !== false,
    },
    signal
  );
  
  return result as WriteResult;
}

export async function containerEdit(
  env: Env,
  containerId: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
  signal?: AbortSignal
): Promise<EditResult> {
  const result = await callContainerRuntime(
    env,
    containerId,
    "/edit",
    {
      path,
      oldString,
      newString,
      replaceAll: replaceAll || false,
    },
    signal
  );
  
  return result as EditResult;
}

export async function containerGrep(
  env: Env,
  containerId: string,
  pattern: string,
  path?: string,
  include?: string,
  maxMatches?: number,
  signal?: AbortSignal
): Promise<GrepResult> {
  const result = await callContainerRuntime(
    env,
    containerId,
    "/grep",
    {
      pattern,
      path: path || ".",
      include,
      maxMatches: maxMatches || 100,
    },
    signal
  );
  
  return result as GrepResult;
}

export async function containerFind(
  env: Env,
  containerId: string,
  path?: string,
  name?: string,
  type?: "file" | "directory" | "any",
  maxResults?: number,
  signal?: AbortSignal
): Promise<FindResult> {
  const result = await callContainerRuntime(
    env,
    containerId,
    "/find",
    {
      path: path || ".",
      name,
      type: type || "any",
      maxResults: maxResults || 200,
    },
    signal
  );
  
  return result as FindResult;
}

export async function containerLs(
  env: Env,
  containerId: string,
  path?: string,
  recursive?: boolean,
  maxResults?: number,
  signal?: AbortSignal
): Promise<LsResult> {
  const result = await callContainerRuntime(
    env,
    containerId,
    "/ls",
    {
      path: path || ".",
      recursive: recursive || false,
      maxResults: maxResults || 200,
    },
    signal
  );
  
  return result as LsResult;
}
