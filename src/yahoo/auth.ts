import { promises as fs } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../env.js";

const AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
export const TOKEN_FILE = path.join(PROJECT_ROOT, ".cache", "yahoo-token.json");

interface StoredToken {
  access_token: string;
  refresh_token: string;
  /** epoch ms */
  expires_at: number;
}

export function yahooConfig() {
  const clientId = process.env.YAHOO_CLIENT_ID;
  const clientSecret = process.env.YAHOO_CLIENT_SECRET;
  const redirectUri = process.env.YAHOO_REDIRECT_URI ?? "https://localhost:8080/callback";
  if (!clientId || !clientSecret) {
    throw new Error("YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET must be set in .env (see .env.example).");
  }
  return { clientId, clientSecret, redirectUri, leagueId: process.env.YAHOO_LEAGUE_ID };
}

export function authorizeUrl(state: string): string {
  const { clientId, redirectUri } = yahooConfig();
  // fspt-r = Fantasy Sports read-only. Override with YAHOO_SCOPE if Yahoo changes it.
  const scope = process.env.YAHOO_SCOPE ?? "fspt-r";
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", state, scope });
  return `${AUTH_URL}?${q}`;
}

async function requestToken(params: Record<string, string>): Promise<StoredToken> {
  const { clientId, clientSecret, redirectUri } = yahooConfig();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ redirect_uri: redirectUri, ...params }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Yahoo token request failed (${res.status}): ${body.error_description ?? body.error ?? "unknown error"}`);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

async function save(token: StoredToken) {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(token), { mode: 0o600 });
}

export async function exchangeCode(code: string) {
  await save(await requestToken({ grant_type: "authorization_code", code }));
}

/** Returns a valid access token, refreshing (and re-saving) it when it is close to expiry. */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  let stored: StoredToken;
  try {
    stored = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
  } catch {
    throw new Error("Not logged in to Yahoo. Run `npm run yahoo:auth` once to authorize.");
  }
  if (!forceRefresh && stored.expires_at - Date.now() > 60_000) return stored.access_token;
  const fresh = await requestToken({ grant_type: "refresh_token", refresh_token: stored.refresh_token });
  // Yahoo may omit a new refresh token; keep the old one in that case.
  await save({ ...fresh, refresh_token: fresh.refresh_token ?? stored.refresh_token });
  return fresh.access_token;
}
