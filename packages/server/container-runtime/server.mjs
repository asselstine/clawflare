#!/usr/bin/env node
/**
 * Clawflare Container Runtime Server
 *
 * A minimal HTTP server that runs inside the container and provides
 * secure command execution and file operations within the workspace.
 *
 * This server listens on port 8080 by default and provides JSON APIs
 * for bash execution and file operations.
 */

import { createServer } from "http";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  readdir,
  access,
  constants,
  rename,
} from "fs/promises";
import { dirname, resolve, normalize, relative, sep } from "path";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/workspace";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_MAX_OUTPUT_CHARS = 8000;
const MAX_COMMAND_BUFFER_CHARS = 1_000_000;

const commands = new Map();

// Ensure workspace exists
async function ensureWorkspace() {
  try {
    await mkdir(WORKSPACE_ROOT, { recursive: true });
  } catch (error) {
    console.error("Failed to create workspace:", error);
  }
}

// Normalize and validate path is within workspace
function isPathWithinWorkspace(requestPath) {
  const resolved = resolve(WORKSPACE_ROOT, requestPath);
  const normalized = normalize(resolved);
  const relativePath = relative(WORKSPACE_ROOT, normalized);

  // Path traversal check
  if (relativePath.startsWith("..") || relativePath.startsWith(sep)) {
    return false;
  }

  return normalized.startsWith(WORKSPACE_ROOT);
}

function sanitizePath(requestPath) {
  if (!requestPath || typeof requestPath !== "string") {
    throw new Error("Path is required and must be a string");
  }

  const resolved = resolve(WORKSPACE_ROOT, requestPath);
  if (!isPathWithinWorkspace(requestPath)) {
    throw new Error(`Path "${requestPath}" escapes the workspace boundary`);
  }

  return resolved;
}

// Execute a bash command
async function executeBash(command, cwd = ".", timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const startTime = Date.now();
  const resolvedCwd = sanitizePath(cwd);

  // Clamp timeout
  const effectiveTimeout = Math.min(Math.max(1000, timeoutMs), MAX_TIMEOUT_MS);

  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let killed = false;

    // Use bash -lc to load profile and execute command
    const proc = spawn("/bin/bash", ["-lc", command], {
      cwd: resolvedCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME || "/root" },
    });

    const timeoutId = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5000);
    }, effectiveTimeout);

    proc.stdout.on("data", (data) => {
      stdout.push(data.toString("utf-8"));
    });

    proc.stderr.on("data", (data) => {
      stderr.push(data.toString("utf-8"));
    });

    proc.on("error", (error) => {
      clearTimeout(timeoutId);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        stdout: stdout.join(""),
        stderr: stderr.join("") || error.message,
        durationMs: Date.now() - startTime,
        truncated: false,
        killed,
        error: error.message,
      });
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timeoutId);

      const fullStdout = stdout.join("");
      const fullStderr = stderr.join("");

      // Truncate output
      const combined = fullStdout + (fullStderr ? `\nStderr:\n${fullStderr}` : "");
      let truncatedOutput = combined;
      let truncated = false;

      if (combined.length > maxOutputChars) {
        const prefix = `[Output truncated. Showing tail. Original length: ${combined.length} chars. Limit: ${maxOutputChars} chars.]\n`;
        truncatedOutput = prefix + combined.slice(-(maxOutputChars - prefix.length));
        truncated = true;
      }

      resolve({
        ok: code === 0 && !killed,
        exitCode: code,
        signal: signal || null,
        stdout: fullStdout,
        stderr: fullStderr,
        durationMs: Date.now() - startTime,
        truncated,
        killed,
        output: truncatedOutput,
      });
    });
  });
}

function appendCommandOutput(record, stream, value) {
  record[stream] += value;
  if (record[stream].length > MAX_COMMAND_BUFFER_CHARS) {
    record[stream] = record[stream].slice(-MAX_COMMAND_BUFFER_CHARS);
    record.outputBufferTruncated = true;
  }
}

function formatCommandOutput(record, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const fullStdout = record.stdout;
  const fullStderr = record.stderr;
  const combined = fullStdout + (fullStderr ? `\nStderr:\n${fullStderr}` : "");
  let truncatedOutput = combined;
  let truncated = Boolean(record.outputBufferTruncated);

  if (combined.length > maxOutputChars) {
    const prefix = `[Output truncated. Showing tail. Original length: ${combined.length} chars. Limit: ${maxOutputChars} chars.]\n`;
    truncatedOutput = prefix + combined.slice(-(maxOutputChars - prefix.length));
    truncated = true;
  }

  return {
    stdout: fullStdout,
    stderr: fullStderr,
    truncated,
    output: truncatedOutput,
  };
}

function commandResult(record, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const output = formatCommandOutput(record, maxOutputChars);
  const durationMs = (record.finishedAt || Date.now()) - record.startedAt;
  const isRunning = record.state === "running";
  const ok = isRunning ? true : record.exitCode === 0 && !record.killed;

  return {
    ok,
    commandId: record.id,
    state: record.state,
    exitCode: isRunning ? null : record.exitCode,
    signal: isRunning ? null : record.signal,
    stdout: output.stdout,
    stderr: output.stderr,
    durationMs,
    truncated: output.truncated,
    killed: record.killed,
    output: output.output,
  };
}

function startBashCommand(command, cwd = ".", timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const resolvedCwd = sanitizePath(cwd);
  const effectiveTimeout = Math.min(Math.max(1000, timeoutMs), MAX_TIMEOUT_MS);
  const commandId = randomUUID();
  const startedAt = Date.now();

  const record = {
    id: commandId,
    command,
    cwd: resolvedCwd,
    startedAt,
    finishedAt: null,
    timeoutMs: effectiveTimeout,
    maxOutputChars,
    stdout: "",
    stderr: "",
    outputBufferTruncated: false,
    killed: false,
    exitCode: null,
    signal: null,
    state: "running",
    proc: null,
  };

  const proc = spawn("/bin/bash", ["-lc", command], {
    cwd: resolvedCwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: process.env.HOME || "/root" },
  });
  record.proc = proc;
  commands.set(commandId, record);

  const timeoutId = setTimeout(() => {
    record.killed = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    }, 5000);
  }, effectiveTimeout);

  proc.stdout.on("data", (data) => {
    appendCommandOutput(record, "stdout", data.toString("utf-8"));
  });

  proc.stderr.on("data", (data) => {
    appendCommandOutput(record, "stderr", data.toString("utf-8"));
  });

  proc.on("error", (error) => {
    clearTimeout(timeoutId);
    record.finishedAt = Date.now();
    record.stderr ||= error.message;
    record.error = error.message;
    record.state = "error";
    record.proc = null;
  });

  proc.on("close", (code, signal) => {
    clearTimeout(timeoutId);
    record.finishedAt = Date.now();
    record.exitCode = code;
    record.signal = signal || null;
    record.state = code === 0 && !record.killed ? "complete" : "error";
    record.proc = null;
  });

  return {
    ok: true,
    commandId,
    state: "running",
    startedAt,
    timeoutMs: effectiveTimeout,
  };
}

function getCommand(commandId) {
  const record = commands.get(commandId);
  if (!record) {
    throw new Error(`Unknown commandId: ${commandId}`);
  }
  return record;
}

function cancelCommand(commandId) {
  const record = getCommand(commandId);
  if (record.state !== "running") return commandResult(record);

  record.killed = true;
  record.state = "cancelled";
  record.finishedAt = Date.now();
  record.proc?.kill("SIGTERM");
  return commandResult(record);
}

// Read a file
async function readFileOp(filePath, startLine, endLine, maxBytes = 200000) {
  const resolvedPath = sanitizePath(filePath);

  // Check file exists and is readable
  await access(resolvedPath, constants.R_OK);

  const stats = await stat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`"${filePath}" is not a regular file`);
  }

  // Limit file size for safety
  if (stats.size > maxBytes) {
    throw new Error(`File "${filePath}" is too large (${stats.size} bytes). Max: ${maxBytes} bytes.`);
  }

  let content = await readFile(resolvedPath, { encoding: "utf-8" });
  const totalLines = content.split("\n").length;

  // Apply line range if specified
  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split("\n");
    const start = Math.max(0, (startLine || 1) - 1);
    const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
    content = lines.slice(start, end).join("\n");
  }

  return {
    ok: true,
    content,
    path: relative(WORKSPACE_ROOT, resolvedPath),
    totalLines,
    size: stats.size,
  };
}

// Write a file
async function writeFileOp(filePath, content, append = false, makeDirs = true) {
  const resolvedPath = sanitizePath(filePath);

  // Create parent directories if needed
  if (makeDirs) {
    await mkdir(dirname(resolvedPath), { recursive: true });
  }

  const flags = append ? "a" : "w";
  const existingSize = append ? (await stat(resolvedPath).catch(() => ({ size: 0 }))).size : 0;

  await writeFile(resolvedPath, content, { encoding: "utf-8", flag: flags });

  const newStats = await stat(resolvedPath);

  return {
    ok: true,
    path: relative(WORKSPACE_ROOT, resolvedPath),
    bytesWritten: Buffer.byteLength(content, "utf-8"),
    totalSize: newStats.size,
    appended: append,
  };
}

// Edit a file using exact string replacement
async function editFileOp(filePath, oldString, newString, replaceAll = false) {
  const resolvedPath = sanitizePath(filePath);

  await access(resolvedPath, constants.R_OK | constants.W_OK);

  const stats = await stat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`"${filePath}" is not a regular file`);
  }

  const content = await readFile(resolvedPath, { encoding: "utf-8" });

  // Count matches
  const matchCount = content.split(oldString).length - 1;

  if (matchCount === 0) {
    throw new Error(`Old string not found in "${filePath}". No changes made.`);
  }

  if (!replaceAll && matchCount > 1) {
    throw new Error(`Found ${matchCount} matches in "${filePath}". Set replaceAll=true to replace all, or be more specific with oldString.`);
  }

  const newContent = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  // Atomic write using temp file
  const tempPath = `${resolvedPath}.tmp.${Date.now()}`;
  await writeFile(tempPath, newContent, { encoding: "utf-8" });
  await rename(tempPath, resolvedPath);

  return {
    ok: true,
    path: relative(WORKSPACE_ROOT, resolvedPath),
    replacements: matchCount,
    oldString,
    newString,
  };
}

// Grep for pattern in files
async function grepOp(pattern, searchPath = ".", includePattern, maxMatches = 100) {
  const resolvedPath = sanitizePath(searchPath);
  const stats = await stat(resolvedPath);

  const results = [];

  if (stats.isFile()) {
    // Single file grep
    const content = await readFile(resolvedPath, { encoding: "utf-8" });
    const lines = content.split("\n");

    for (let i = 0; i < lines.length && results.length < maxMatches; i++) {
      if (lines[i].includes(pattern)) {
        results.push({
          path: relative(WORKSPACE_ROOT, resolvedPath),
          line: i + 1,
          text: lines[i].slice(0, 200), // Limit line length
        });
      }
    }
  } else if (stats.isDirectory()) {
    // Recursive grep - we'll use bash for this
    const includeArg = includePattern ? `--include="${includePattern}"` : "";
    const result = await executeBash(
      `rg --json ${includeArg || "--type-not binary"} "${pattern.replace(/"/g, '\\"')}" "${resolvedPath}" 2>/dev/null || grep -rIn ${includeArg ? `--include="${includePattern}"` : ""} "${pattern.replace(/"/g, '\\"')}" "${resolvedPath}" 2>/dev/null | head -${maxMatches}`,
      ".",
      30000,
      10000
    );

    // Parse results
    const output = result.stdout + result.stderr;
    if (output) {
      for (const line of output.split("\n").slice(0, maxMatches)) {
        if (!line.trim()) continue;
        // Try to parse ripgrep JSON or grep -rIn format
        // grep -rIn: file:line:text
        const match = line.match(/^([^:]+):(\d+):(.*)$/);
        if (match) {
          const [, filePath, lineNum, text] = match;
          if (!filePath.includes("Binary")) {
            results.push({
              path: relative(WORKSPACE_ROOT, resolve(WORKSPACE_ROOT, filePath)),
              line: parseInt(lineNum, 10),
              text: text.slice(0, 200),
            });
          }
        }
      }
    }
  }

  return {
    ok: true,
    pattern,
    path: relative(WORKSPACE_ROOT, resolvedPath),
    matches: results,
    matchCount: results.length,
    truncated: results.length >= maxMatches,
  };
}

function globPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+.\-]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

// Find files
async function findOp(searchPath = ".", namePattern, type = "any", maxResults = 200) {
  const resolvedPath = sanitizePath(searchPath);

  const results = [];

  async function traverse(dir) {
    if (results.length >= maxResults) return;

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      const fullPath = resolve(dir, entry.name);
      const relativePath = relative(WORKSPACE_ROOT, fullPath);

      // Skip hidden files and dirs
      if (entry.name.startsWith(".")) continue;

      let matchesType = true;
      if (type === "file") matchesType = entry.isFile();
      if (type === "directory") matchesType = entry.isDirectory();

      let matchesName = true;
      if (namePattern) {
        // Simple glob matching
        const regex = globPatternToRegExp(namePattern);
        matchesName = regex.test(entry.name);
      }

      if (matchesType && matchesName) {
        const stats = await stat(fullPath).catch(() => null);
        results.push({
          path: relativePath,
          type: entry.isDirectory() ? "directory" : "file",
          size: stats?.size || 0,
          mtime: stats?.mtime?.toISOString() || null,
        });
      }

      if (entry.isDirectory()) {
        await traverse(fullPath);
      }
    }
  }

  await traverse(resolvedPath);

  return {
    ok: true,
    path: relative(WORKSPACE_ROOT, resolvedPath),
    results,
    resultCount: results.length,
    truncated: results.length >= maxResults,
  };
}

// List directory contents
async function lsOp(dirPath = ".", recursive = false, maxResults = 200) {
  const resolvedPath = sanitizePath(dirPath);

  const stats = await stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error(`"${dirPath}" is not a directory`);
  }

  const results = [];

  async function traverse(dir, depth = 0) {
    if (results.length >= maxResults) return;

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      // Skip hidden files
      if (entry.name.startsWith(".")) continue;

      const fullPath = resolve(dir, entry.name);
      const relativePath = relative(WORKSPACE_ROOT, fullPath);

      const entryStats = await stat(fullPath).catch(() => null);

      results.push({
        path: relativePath,
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        size: entryStats?.size || 0,
        mode: entryStats?.mode?.toString(8) || null,
        mtime: entryStats?.mtime?.toISOString() || null,
        depth,
      });

      if (entry.isDirectory() && recursive) {
        await traverse(fullPath, depth + 1);
      }
    }
  }

  await traverse(resolvedPath);

  return {
    ok: true,
    path: relative(WORKSPACE_ROOT, resolvedPath),
    entries: results,
    entryCount: results.length,
    truncated: results.length >= maxResults,
  };
}

// Request handlers
const handlers = {
  "/health": async (_req) => {
    return {
      ok: true,
      status: "healthy",
      workspace: WORKSPACE_ROOT,
    };
  },

  "/bash": async (req) => {
    const body = await parseBody(req);
    const { command, cwd = ".", timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS } = body;

    if (!command || typeof command !== "string") {
      throw new Error("command is required");
    }

    return await executeBash(command, cwd, timeoutMs, maxOutputChars);
  },

  "/bash/start": async (req) => {
    const body = await parseBody(req);
    const { command, cwd = ".", timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS } = body;

    if (!command || typeof command !== "string") {
      throw new Error("command is required");
    }

    return startBashCommand(command, cwd, timeoutMs, maxOutputChars);
  },

  "/bash/status": async (req) => {
    const body = await parseBody(req);
    const { commandId, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS } = body;

    if (!commandId || typeof commandId !== "string") {
      throw new Error("commandId is required");
    }

    return commandResult(getCommand(commandId), maxOutputChars);
  },

  "/bash/cancel": async (req) => {
    const body = await parseBody(req);
    const { commandId } = body;

    if (!commandId || typeof commandId !== "string") {
      throw new Error("commandId is required");
    }

    return cancelCommand(commandId);
  },

  "/read": async (req) => {
    const body = await parseBody(req);
    const { path, startLine, endLine, maxBytes = 200000 } = body;

    if (!path || typeof path !== "string") {
      throw new Error("path is required");
    }

    return await readFileOp(path, startLine, endLine, maxBytes);
  },

  "/write": async (req) => {
    const body = await parseBody(req);
    const { path, content, append = false, makeDirs = true } = body;

    if (!path || typeof path !== "string") {
      throw new Error("path is required");
    }
    if (content === undefined) {
      throw new Error("content is required");
    }

    return await writeFileOp(path, String(content), append, makeDirs);
  },

  "/edit": async (req) => {
    const body = await parseBody(req);
    const { path, oldString, newString, replaceAll = false } = body;

    if (!path || typeof path !== "string") {
      throw new Error("path is required");
    }
    if (!oldString || typeof oldString !== "string") {
      throw new Error("oldString is required");
    }
    if (newString === undefined) {
      throw new Error("newString is required");
    }

    return await editFileOp(path, oldString, newString, replaceAll);
  },

  "/grep": async (req) => {
    const body = await parseBody(req);
    const { pattern, path = ".", include, maxMatches = 100 } = body;

    if (!pattern || typeof pattern !== "string") {
      throw new Error("pattern is required");
    }

    return await grepOp(pattern, path, include, maxMatches);
  },

  "/find": async (req) => {
    const body = await parseBody(req);
    const { path = ".", name, type = "any", maxResults = 200 } = body;

    return await findOp(path, name, type, maxResults);
  },

  "/ls": async (req) => {
    const body = await parseBody(req);
    const { path = ".", recursive = false, maxResults = 200 } = body;

    return await lsOp(path, recursive, maxResults);
  },
};

// Parse JSON body
async function parseBody(req) {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    if (!body) return {};
    return JSON.parse(body);
  } catch (e) {
    throw new Error("Invalid JSON body: " + e.message);
  }
}

// Send JSON response
function jsonResponse(res, data, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Create and start server
async function main() {
  await ensureWorkspace();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      // Only accept POST for commands, GET for health
      const handler = handlers[url.pathname];

      if (!handler) {
        jsonResponse(res, { ok: false, error: `Unknown endpoint: ${url.pathname}` }, 404);
        return;
      }

      if (url.pathname === "/health" && req.method !== "GET") {
        jsonResponse(res, { ok: false, error: "Method not allowed" }, 405);
        return;
      }

      if (url.pathname !== "/health" && req.method !== "POST") {
        jsonResponse(res, { ok: false, error: "Method not allowed" }, 405);
        return;
      }

      const result = await handler(req);
      jsonResponse(res, result);
    } catch (error) {
      console.error("Error handling request:", error);
      jsonResponse(res, {
        ok: false,
        error: error.message || "Internal server error",
      }, 500);
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Clawflare Container Runtime Server running on port ${PORT}`);
    console.log(`Workspace: ${WORKSPACE_ROOT}`);
  });
}

main().catch(console.error);
