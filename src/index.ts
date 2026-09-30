#!/usr/bin/env node
import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { USERNAME } from "./sleeper/client.js";
import { registerSleeperTools } from "./sleeper/tools.js";

const server = new McpServer({ name: "fantasy-football-analyzer", version: "0.1.0" });

registerSleeperTools(server);

await server.connect(new StdioServerTransport());
console.error(`fantasy-football-analyzer MCP server running (sleeper user: ${USERNAME})`);
