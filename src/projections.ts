import { round } from "./guillotine.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
const QS = POSITIONS.map((p) => `position[]=${p}`).join("&");
const PROJECTION_TTL_MS = 15 * 60 * 1000;

export type Scoring = Record<string, number>;

export interface Projection {
  player_id: string;
  opponent: string | null;
  stats: Record<string, number>;
}

async function fetchRows(kind: "projections" | "stats", season: string, week: number): Promise<any[]> {
  const url = `https://api.sleeper.com/${kind}/nfl/${season}/${week}?season_type=regular&${QS}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper ${kind} API ${res.status}`);
  return (await res.json()) as any[];
}

/** Score a raw stat line with the league's own scoring settings (ignores Sleeper's generic pts_* totals). */
export function scoreStats(stats: Record<string, number>, scoring: Scoring): number {
  let total = 0;
  for (const [k, v] of Object.entries(stats)) {
    const weight = scoring[k];
    if (weight && typeof v === "number") total += v * weight;
  }
  return round(total);
}

const projCache = new Map<number, { at: number; rows: Map<string, Projection> }>();

export async function getProjections(season: string, week: number): Promise<Map<string, Projection>> {
  const hit = projCache.get(week);
  if (hit && Date.now() - hit.at < PROJECTION_TTL_MS) return hit.rows;
  const rows = new Map<string, Projection>();
  for (const r of await fetchRows("projections", season, week)) {
    rows.set(r.player_id, { player_id: r.player_id, opponent: r.opponent ?? null, stats: r.stats ?? {} });
  }
  projCache.set(week, { at: Date.now(), rows });
  return rows;
}

// Past weeks never change, so keep them for the life of the process.
const statCache = new Map<number, Map<string, Record<string, number>>>();

export async function getWeekStats(season: string, week: number) {
  const hit = statCache.get(week);
  if (hit) return hit;
  const rows = new Map<string, Record<string, number>>();
  for (const r of await fetchRows("stats", season, week)) rows.set(r.player_id, r.stats ?? {});
  statCache.set(week, rows);
  return rows;
}

/** Points scored in each of the last `n` completed weeks (null = didn't play). Oldest first. */
export async function recentPoints(season: string, currentWeek: number, scoring: Scoring, n = 3) {
  const weeks: number[] = [];
  for (let w = Math.max(1, currentWeek - n); w < currentWeek; w++) weeks.push(w);
  const perWeek = await Promise.all(weeks.map((w) => getWeekStats(season, w)));
  return (id: string) => {
    const pts = perWeek.map((m) => {
      const s = m.get(id);
      return s && (s.gp ?? 0) > 0 ? scoreStats(s, scoring) : null;
    });
    const played = pts.filter((p): p is number => p !== null);
    return {
      recent: pts,
      recent_avg: played.length ? round(played.reduce((a, b) => a + b, 0) / played.length) : null,
      recent_min: played.length ? Math.min(...played) : null,
    };
  };
}

const SLOT_ELIGIBILITY: Record<string, string[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  WRRB_FLEX: ["WR", "RB"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

/** Positions that can fill at least one starting slot in this league. */
export function startablePositions(rosterPositions: string[]): Set<string> {
  return new Set(rosterPositions.flatMap((s) => SLOT_ELIGIBILITY[s] ?? []));
}

export interface Candidate {
  id: string;
  pos: string;
  pts: number;
}

/** Best lineup for the league's starting slots. Fixed-position slots fill first, then flex slots. */
export function optimalLineup(rosterPositions: string[], pool: Candidate[]) {
  const slots = rosterPositions.filter((s) => s !== "BN" && s in SLOT_ELIGIBILITY);
  const ordered = [...slots].sort((a, b) => SLOT_ELIGIBILITY[a].length - SLOT_ELIGIBILITY[b].length);
  const remaining = [...pool].sort((a, b) => b.pts - a.pts);
  const picks: { slot: string; player: Candidate | null }[] = [];
  for (const slot of ordered) {
    const i = remaining.findIndex((c) => SLOT_ELIGIBILITY[slot].includes(c.pos));
    picks.push({ slot, player: i >= 0 ? remaining.splice(i, 1)[0] : null });
  }
  return { picks, total: round(picks.reduce((s, p) => s + (p.player?.pts ?? 0), 0)) };
}
