/**
 * Clawflare CLI - doctor command
 * Diagnoses authentication and connection issues
 */

import { AgentClient } from "../client.js";
import { loadConfig } from "./login.js";
import { DEFAULT_SERVER } from "../constants.js";

interface DoctorOptions {
  server?: string;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  console.log("Clawflare CLI Doctor");
  console.log("====================\n");

  // Load config
  console.log("1. Loading configuration...");
  const config = await loadConfig();
  
  const server = options.server || config.server || process.env.CLAWFLARE_URL || DEFAULT_SERVER;
  const token = config.token;
  
  console.log(`   Server: ${server}`);
  console.log(`   Token from config: ${config.token ? "Yes (" + config.token.slice(0, 10) + "...)" : "No"}`);
  console.log(`   Token to use: ${token ? "Yes (" + token.slice(0, 10) + "...)" : "No"}`);
  console.log();

  if (!token) {
    console.error("✗ No token found. Run 'clawflare login' first.");
    process.exit(1);
  }

  // Test connection with verbose output
  console.log("2. Testing connection to server...");
  console.log(`   URL: ${server}`);
  
  try {
    const infoResponse = await fetch(`${server}/v1/info`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    
    console.log(`   Response status: ${infoResponse.status}`);
    console.log(`   Response headers: ${JSON.stringify(Object.fromEntries(infoResponse.headers.entries()))}`);
    
    const text = await infoResponse.text();
    console.log(`   Response body: ${text.slice(0, 500)}`);
    
    if (!infoResponse.ok) {
      console.error(`\n✗ /v1/info request failed: ${infoResponse.status}`);
    } else {
      console.log("\n✓ /v1/info request succeeded");
    }
  } catch (error) {
    console.error(`\n✗ Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Test /v1/me endpoint
  console.log("\n3. Testing authenticated endpoint (/v1/me)...");
  
  try {
    const meResponse = await fetch(`${server}/v1/me`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    
    console.log(`   Response status: ${meResponse.status}`);
    
    const text = await meResponse.text();
    console.log(`   Response body: ${text.slice(0, 500)}`);
    
    if (!meResponse.ok) {
      console.error(`\n✗ /v1/me request failed: ${meResponse.status}`);
    } else {
      console.log("\n✓ /v1/me request succeeded");
    }
  } catch (error) {
    console.error(`\n✗ /v1/me failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test with AgentClient
  console.log("\n4. Testing with AgentClient...");
  
  try {
    const client = new AgentClient(server, token, config.workspace);
    const serverInfo = await client.getServerInfo();
    console.log(`   Server provider: ${serverInfo.provider}`);
    console.log(`   Server model: ${serverInfo.model}`);
    console.log("\n✓ AgentClient.getServerInfo() succeeded");
  } catch (error) {
    console.error(`\n✗ AgentClient failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("\n====================");
  console.log("Diagnosis complete.");
}
