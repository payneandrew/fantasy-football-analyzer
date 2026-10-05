import { getAccessToken } from "./auth.js";

const BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

/** GET a Yahoo Fantasy resource as JSON. `path` is relative to /fantasy/v2, e.g. "league/<game_key>.l.<league_id>/settings". */
export async function yahooGet(path: string): Promise<any> {
  const url = `${BASE}/${path}${path.includes("?") ? "&" : "?"}format=json`;
  const call = async (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let res = await call(await getAccessToken());
  if (res.status === 401) res = await call(await getAccessToken(true)); // token revoked or expired early
  if (!res.ok) throw new Error(`Yahoo API ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
