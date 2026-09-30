import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from this file, not the cwd, so it works however the MCP client launches the server.
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(PROJECT_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables that are already set
