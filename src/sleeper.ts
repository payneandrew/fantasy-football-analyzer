import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = "https://api.sleeper.app/v1";
const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const PLAYERS_FILE = path.join(CACHE_DIR, "players.json");
const PLAYERS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const USERNAME = process.env.SLEEPER_USERNAME ?? "paynis";

export interface Player {
  player_id: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  team?: string | null;
  status?: string;
  injury_status?: string | null;
  injury_body_part?: string | null;
  age?: number;
  search_rank?: number;
  years_exp?: number;
  depth_chart_order?: number | null;
}

export interface Roster {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
  settings: {
    wins: number;
    losses: number;
    ties: number;
    fpts: number;
    fpts_decimal?: number;
    fpts_against?: number;
    waiver_position?: number;
    waiver_budget_used?: number;
  };
}

export interface LeagueUser {
  user_id: string;
  display_name: string;
  metadata?: { team_name?: string };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export const sleeper = {
  get: <T>(p: string) => getJson<T>(`${BASE}${p}`),

  async state() {
    return this.get<{ week: number; season: string; season_type: string }>("/state/nfl");
  },

  async userId(): Promise<string> {
    const u = await this.get<{ user_id: string }>(`/user/${USERNAME}`);
    return u.user_id;
  },
};

// The full player DB is ~5MB+, so cache it on disk and refresh at most daily.
let playersMemo: Record<string, Player> | null = null;

export async function getPlayers(): Promise<Record<string, Player>> {
  if (playersMemo) return playersMemo;
  try {
    const stat = await fs.stat(PLAYERS_FILE);
    if (Date.now() - stat.mtimeMs < PLAYERS_MAX_AGE_MS) {
      playersMemo = JSON.parse(await fs.readFile(PLAYERS_FILE, "utf8"));
      return playersMemo!;
    }
  } catch {
    // no cache yet
  }
  const fresh = await sleeper.get<Record<string, Player>>("/players/nfl");
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(PLAYERS_FILE, JSON.stringify(fresh));
  playersMemo = fresh;
  return fresh;
}

export function playerName(p: Player | undefined, id: string): string {
  if (!p) return id; // team defenses use ids like "SEA"
  return p.full_name ?? (`${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || id);
}

export function describePlayer(players: Record<string, Player>, id: string) {
  const p = players[id];
  return {
    id,
    name: id === "0" ? "(empty slot)" : playerName(p, id),
    pos: p?.position ?? (p ? undefined : "DEF"),
    team: p?.team ?? undefined,
    injury: p?.injury_status ?? undefined,
    status: p?.status && p.status !== "Active" ? p.status : undefined,
  };
}
