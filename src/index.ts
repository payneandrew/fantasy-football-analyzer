#!/usr/bin/env node
import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { USERNAME } from "./sleeper/client.js";
import { registerSleeperTools } from "./sleeper/tools.js";
import { registerYahooTools } from "./yahoo/tools.js";

const server = new McpServer({ name: "fantasy-football-analyzer", version: "0.1.0" });

registerSleeperTools(server);
// Yahoo needs credentials and a saved login, so cloud sessions without them skip it.
if (process.env.YAHOO_CLIENT_ID) registerYahooTools(server);

await server.connect(new StdioServerTransport());
console.error(`fantasy-football-analyzer MCP server running (sleeper user: ${USERNAME})`);
