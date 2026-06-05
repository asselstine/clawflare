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

  // Test authenticated user endpoint with verbose output
  console.log("2. Testing authenticated endpoint (/v1/users/me)...");
  console.log(`   URL: ${server}`);
  
  try {
    const userResponse = await fetch(`${server}/v1/users/me`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    
    console.log(`   Response status: ${userResponse.status}`);
    console.log(`   Response headers: ${JSON.stringify(Object.fromEntries(userResponse.headers.entries()))}`);
    
    const text = await userResponse.text();
    console.log(`   Response body: ${text.slice(0, 500)}`);
    
    if (!userResponse.ok) {
      console.error(`\n✗ /v1/users/me request failed: ${userResponse.status}`);
    } else {
      console.log("\n✓ /v1/users/me request succeeded");
    }
  } catch (error) {
    console.error(`\n✗ Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Test /v1/workspace endpoint
  console.log("\n3. Testing workspace endpoint (/v1/workspace)...");
  
  try {
    const workspaceResponse = await fetch(`${server}/v1/workspace`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    
    console.log(`   Response status: ${workspaceResponse.status}`);
    
    const text = await workspaceResponse.text();
    console.log(`   Response body: ${text.slice(0, 500)}`);
    
    if (!workspaceResponse.ok) {
      console.error(`\n✗ /v1/workspace request failed: ${workspaceResponse.status}`);
    } else {
      console.log("\n✓ /v1/workspace request succeeded");
    }
  } catch (error) {
    console.error(`\n✗ /v1/workspace failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test with AgentClient
  console.log("\n4. Testing with AgentClient...");
  
  try {
    const client = new AgentClient(server, token, config.workspace);
    const [user, workspace, providers, configuredProviders, models] = await Promise.all([
      client.getCurrentUser(),
      client.getWorkspace(),
      client.listProviders(),
      client.listConfiguredProviders(),
      client.listModels(),
    ]);
    console.log(`   User: ${user.user.displayName || user.user.email}`);
    console.log(`   Workspace: ${workspace.name} (${workspace.slug})`);
    console.log(`   Supported providers: ${providers.map((provider) => provider.id).join(", ") || "none"}`);
    console.log(`   Configured providers: ${configuredProviders.length}`);
    console.log(`   Models: ${models.models.length}`);
    console.log(`   Default model: ${models.defaultModelId || workspace.defaultModelId || "none"}`);
    console.log("\n✓ AgentClient endpoint checks succeeded");
  } catch (error) {
    console.error(`\n✗ AgentClient failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("\n====================");
  console.log("Diagnosis complete.");
}
