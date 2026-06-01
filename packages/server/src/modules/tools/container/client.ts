/**
 * Container Client - Worker-side RPC client for the container runtime server
 */

import { getContainer } from "@cloudflare/containers";
import type { Env } from "../../../internal-types/index.js";

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

// Default timeout for container operations
const DEFAULT_CONTAINER_TIMEOUT = 30000;
const MAX_CONTAINER_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MAX_ERROR_DETAIL_CHARS = 8000;

interface RuntimeCallOptions {
  allowRuntimeFailure?: boolean;
}

function truncateDetail(value: string): string {
  if (value.length <= MAX_ERROR_DETAIL_CHARS) return value;

  return `[Truncated to last ${MAX_ERROR_DETAIL_CHARS} chars. Original length: ${value.length} chars.]\n` +
    value.slice(-MAX_ERROR_DETAIL_CHARS);
}

function appendDetail(parts: string[], label: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;

  const text = typeof value === "string" ? value : String(value);
  parts.push(`${label}:\n${truncateDetail(text)}`);
}

export function buildContainerRuntimeFailureMessage(
  response: Pick<Response, "ok" | "status" | "statusText">,
  payload: ContainerRuntimeResponse | null,
  rawBody: string,
): string {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const reason = response.ok
    ? `runtime reported ok=false (HTTP ${response.status}${statusText})`
    : `HTTP ${response.status}${statusText}`;
  const parts = [`Container runtime call failed: ${reason}`];

  if (payload) {
    if (payload.exitCode !== undefined) parts.push(`Exit code: ${payload.exitCode}`);
    if (payload.signal !== undefined && payload.signal !== null) parts.push(`Signal: ${payload.signal}`);
    if (payload.killed === true) parts.push("Process killed due to timeout");
    if (payload.durationMs !== undefined) parts.push(`Duration: ${payload.durationMs}ms`);

    appendDetail(parts, "Error", payload.error);
    appendDetail(parts, "Stdout", payload.stdout);
    appendDetail(parts, "Stderr", payload.stderr);
    appendDetail(parts, "Output", payload.output);
  } else {
    appendDetail(parts, "Response body", rawBody);
  }

  return parts.join("\n");
}

async function readContainerRuntimeResponse(response: Response): Promise<{
  payload: ContainerRuntimeResponse | null;
  rawBody: string;
}> {
  const rawBody = await response.text();
  if (!rawBody) return { payload: null, rawBody };

  try {
    return { payload: JSON.parse(rawBody) as ContainerRuntimeResponse, rawBody };
  } catch {
    return { payload: null, rawBody };
  }
}

// Get container stub using Cloudflare's getContainer helper
function getContainerStub(env: Env, id: string) {
  return getContainer(env.CODING_CONTAINER, id);
}

/**
 * Call the container runtime server
 */
export async function callContainerRuntime(
  env: Env,
  containerId: string,
  endpoint: string,
  body: unknown,
  signal?: AbortSignal,
  options: RuntimeCallOptions = {},
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

  const { payload, rawBody } = await readContainerRuntimeResponse(response);

  if (!response.ok || !payload) {
    throw new Error(buildContainerRuntimeFailureMessage(response, payload, rawBody));
  }

  if (payload.ok === false && !options.allowRuntimeFailure) {
    throw new Error(buildContainerRuntimeFailureMessage(response, payload, rawBody));
  }

  return payload;
}

/**
 * Check if container is healthy
 */
export async function destroyContainer(
  env: Env,
  containerId: string
): Promise<void> {
  const container = getContainerStub(env, containerId);
  await container.destroy();
}

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
    signal,
  });

  const { payload, rawBody } = await readContainerRuntimeResponse(response);

  if (!response.ok || !payload) {
    throw new Error(buildContainerRuntimeFailureMessage(response, payload, rawBody));
  }

  return payload as HealthResult;
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
    signal,
    { allowRuntimeFailure: true }
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
