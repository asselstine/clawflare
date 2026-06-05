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
  commandId?: string;
  state?: "running" | "complete" | "error" | "cancelled";
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

export interface BashStartResult {
  ok: boolean;
  commandId: string;
  state: "running";
  startedAt: number;
  timeoutMs: number;
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
const CONTAINER_START_TIMEOUT = 30_000;
const DEFAULT_CONTAINER_BASH_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MAX_CONTAINER_BASH_TIMEOUT = 60 * 60 * 1000; // 60 minutes
const MAX_ERROR_DETAIL_CHARS = 8000;
const CONTAINER_START_MAX_ATTEMPTS = 2;
const CONTAINER_READY_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTAINER_CODE_UPDATE_RESET_MESSAGE = "Durable Object reset because its code was updated";

interface RuntimeCallOptions {
  allowRuntimeFailure?: boolean;
}

interface CachedContainerReadiness {
  promise: Promise<ReturnType<typeof getContainerStub>>;
  readyAt: number;
}

const containerReadinessCache = new Map<string, CachedContainerReadiness>();

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

export function isContainerCodeUpdateResetError(error: unknown): boolean {
  return error instanceof Error
    ? error.message.includes(CONTAINER_CODE_UPDATE_RESET_MESSAGE)
    : String(error).includes(CONTAINER_CODE_UPDATE_RESET_MESSAGE);
}

export function buildContainerStartupFailureMessage(
  containerId: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);

  if (isContainerCodeUpdateResetError(error)) {
    return [
      `Container ${containerId} was interrupted by a Worker deployment while starting.`,
      "Retry the operation; if this is an older session, the container filesystem may have been reset.",
    ].join(" ");
  }

  return `Container ${containerId} failed to start: ${message}`;
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

function getCachedContainer(containerId: string): Promise<ReturnType<typeof getContainerStub>> | null {
  const cached = containerReadinessCache.get(containerId);
  if (!cached) return null;

  if (Date.now() - cached.readyAt > CONTAINER_READY_CACHE_TTL_MS) {
    containerReadinessCache.delete(containerId);
    return null;
  }

  return cached.promise;
}

async function waitForContainerPort(
  env: Env,
  containerId: string,
  signal?: AbortSignal,
) {
  const cached = getCachedContainer(containerId);
  if (cached) return await cached;

  const readyPromise = startContainerAndConfigureOutbound(env, containerId, signal);
  containerReadinessCache.set(containerId, {
    promise: readyPromise,
    readyAt: Date.now(),
  });

  try {
    return await readyPromise;
  } catch (error) {
    if (containerReadinessCache.get(containerId)?.promise === readyPromise) {
      containerReadinessCache.delete(containerId);
    }
    throw error;
  }
}

async function startContainerAndConfigureOutbound(
  env: Env,
  containerId: string,
  signal?: AbortSignal,
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CONTAINER_START_MAX_ATTEMPTS; attempt += 1) {
    const container = getContainerStub(env, containerId);

    try {
      await container.startAndWaitForPorts({
        ports: [8080],
        startOptions: { enableInternet: false },
        cancellationOptions: { portReadyTimeoutMS: CONTAINER_START_TIMEOUT, abort: signal },
      });
      await container.setOutboundHandler("clawflare", { containerId });
      return container;
    } catch (error) {
      lastError = error;
      if (
        signal?.aborted ||
        !isContainerCodeUpdateResetError(error) ||
        attempt === CONTAINER_START_MAX_ATTEMPTS
      ) {
        break;
      }
    }
  }

  throw new Error(buildContainerStartupFailureMessage(containerId, lastError));
}

function forgetContainerReadiness(containerId: string): void {
  containerReadinessCache.delete(containerId);
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
  const container = await waitForContainerPort(env, containerId, signal);
  let response: Response;

  try {
    response = await container.containerFetch(`http://localhost${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    forgetContainerReadiness(containerId);
    const restartedContainer = await waitForContainerPort(env, containerId, signal);
    response = await restartedContainer.containerFetch(`http://localhost${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

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
  forgetContainerReadiness(containerId);
  const container = getContainerStub(env, containerId);
  await container.destroy();
}

export async function getContainerHealth(
  env: Env,
  containerId: string,
  signal?: AbortSignal
): Promise<HealthResult> {
  const container = await waitForContainerPort(env, containerId, signal);

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
    Math.max(1000, timeoutMs || DEFAULT_CONTAINER_BASH_TIMEOUT),
    MAX_CONTAINER_BASH_TIMEOUT
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

export async function containerBashStart(
  env: Env,
  containerId: string,
  command: string,
  cwd?: string,
  timeoutMs?: number,
  maxOutputChars?: number,
  signal?: AbortSignal
): Promise<BashStartResult> {
  const effectiveTimeout = Math.min(
    Math.max(1000, timeoutMs || DEFAULT_CONTAINER_BASH_TIMEOUT),
    MAX_CONTAINER_BASH_TIMEOUT
  );

  const result = await callContainerRuntime(
    env,
    containerId,
    "/bash/start",
    {
      command,
      cwd: cwd || ".",
      timeoutMs: effectiveTimeout,
      maxOutputChars: maxOutputChars || 8000,
    },
    signal
  );

  return result as BashStartResult;
}

export async function containerBashStatus(
  env: Env,
  containerId: string,
  commandId: string,
  maxOutputChars?: number,
  signal?: AbortSignal
): Promise<BashResult> {
  const result = await callContainerRuntime(
    env,
    containerId,
    "/bash/status",
    {
      commandId,
      maxOutputChars: maxOutputChars || 8000,
    },
    signal,
    { allowRuntimeFailure: true }
  );

  return result as BashResult;
}

export async function containerBashCancel(
  env: Env,
  containerId: string,
  commandId: string,
  signal?: AbortSignal
): Promise<BashResult> {
  const result = await callContainerRuntime(
    env,
    containerId,
    "/bash/cancel",
    { commandId },
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
