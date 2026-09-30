import { execFileSync, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PROJECT_ROOT } from "../env.js";
import { authorizeUrl, exchangeCode, yahooConfig, TOKEN_FILE } from "./auth.js";

// One-time login: Yahoo redirects the browser to an https localhost URL, so we serve it
// with a throwaway self-signed certificate and catch the authorization code.
const { redirectUri } = yahooConfig();
const redirect = new URL(redirectUri);
const port = Number(redirect.port || 443);

const certDir = path.join(PROJECT_ROOT, ".cache");
const keyFile = path.join(certDir, "localhost.key");
const certFile = path.join(certDir, "localhost.crt");
if (!existsSync(certFile)) {
  mkdirSync(certDir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "30", "-subj", "/CN=localhost"], { stdio: "ignore" });
}

const state = randomBytes(16).toString("hex");

const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error || !code || url.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authorization failed${error ? `: ${error}` : ""}. Check the terminal and try again.`);
    console.error(`Authorization failed${error ? `: ${error}` : " (missing code or state mismatch)"}.`);
    process.exit(1);
  }
  try {
    await exchangeCode(code);
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Yahoo authorization complete. You can close this tab.");
    console.log(`Success. Token saved to ${TOKEN_FILE}`);
    server.close(() => process.exit(0));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed. Check the terminal.");
    console.error(String(e));
    process.exit(1);
  }
});

server.listen(port, "127.0.0.1", () => {
  const url = authorizeUrl(state);
  console.log(`Listening on ${redirectUri}\n\nOpen this URL in your browser and approve access:\n\n${url}\n`);
  console.log("Your browser will warn about a self-signed certificate after you approve. That's expected: choose Advanced, then proceed to localhost.");
  if (process.platform === "darwin") execFile("open", [url], () => {});
});
