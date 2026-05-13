#!/usr/bin/env node
/**
 * Development server with proper signal handling
 * 
 * This wrapper ensures that when you press Ctrl+C, all child processes
 * (including wrangler and workerd) are properly terminated.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { createServer } from "node:net";

// Check if port is already in use and kill existing process
async function killExistingOnPort(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`⚠️  Port ${port} in use, attempting to free it...`);
        // Try to kill any existing wrangler/workerd processes
        const cleanup = spawn("sh", ["-c", `lsof -ti:${port} | xargs kill -9 2>/dev/null || pkill -9 -f "wrangler dev" 2>/dev/null || true`], {
          stdio: "ignore",
          detached: true,
        });
        cleanup.on("close", () => {
          // Wait a moment for the port to be released
          setTimeout(resolve, 500);
        });
      } else {
        resolve();
      }
    });
    server.once("listening", () => {
      server.close();
      resolve();
    });
    server.listen(port);
  });
}

let wranglerProcess = null;

function cleanup() {
  if (wranglerProcess) {
    console.log("\n🛑 Shutting down dev server...");
    
    // Try to kill the process group first (for detached processes)
    try {
      if (wranglerProcess.pid) {
        process.kill(-wranglerProcess.pid, "SIGTERM");
      }
    } catch {
      // If that fails, try direct kill
      try {
        wranglerProcess.kill("SIGTERM");
      } catch {
        // Process might already be dead
      }
    }
    
    // Force kill after a short delay if still running
    setTimeout(() => {
      try {
        if (wranglerProcess && wranglerProcess.pid) {
          process.kill(-wranglerProcess.pid, "SIGKILL");
        }
      } catch {
        // Ignore errors
      }
    }, 1000);
  }
  
  // Exit cleanly
  setTimeout(() => process.exit(0), 100);
}

// Handle signals
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Main
try {
  await killExistingOnPort(8787);
  
  console.log("🚀 Starting wrangler dev server...\n");
  
  wranglerProcess = spawn("npx", ["wrangler", "dev"], {
    stdio: "inherit",
    detached: true, // Create new process group so we can kill it
    env: {
      ...process.env,
      // Ensure consistent environment
      NODE_ENV: "development",
    },
  });
  
  // Forward exit code
  wranglerProcess.on("exit", (code) => {
    process.exit(code ?? 0);
  });
  
  wranglerProcess.on("error", (err) => {
    console.error("Failed to start wrangler:", err.message);
    process.exit(1);
  });
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
