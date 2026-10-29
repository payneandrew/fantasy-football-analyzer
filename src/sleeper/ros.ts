import { getProjections, scoreStats, optimalLineup, SLOT_ELIGIBILITY, type Candidate } from "./projections.js";
import { round } from "./guillotine.js";

/** One player's projected points for each remaining week in which his team plays. */
export interface RosEntry {
  weekly: Map<number, number>;
  games: number;
  total: number;
  /** points per game played */
  avg: number;
}
export type Ros = Map<string, RosEntry>;

/**
 * Rest-of-season projections: one RotoWire projection per future week, scored with the league's rules.
 * A week with no game (bye) simply has no entry. Injuries are NOT modeled: Sleeper's future-week
 * projections assume a player is healthy and playing.
 */
export async function loadRos(season: string, fromWeek: number, toWeek: number, scoring: Record<string, number>): Promise<{ ros: Ros; weeks: number[] }> {
  const weeks: number[] = [];
  for (let w = fromWeek; w <= toWeek; w++) weeks.push(w);
  const perWeek = await Promise.all(weeks.map((w) => getProjections(season, w)));
  const ros: Ros = new Map();
  perWeek.forEach((m, i) => {
    for (const [id, p] of m) {
      if (!p.date) continue;
      let e = ros.get(id);
      if (!e) ros.set(id, (e = { weekly: new Map(), games: 0, total: 0, avg: 0 }));
      const pts = scoreStats(p.stats, scoring);
      e.weekly.set(weeks[i], pts);
      e.games++;
      e.total += pts;
    }
  });
  for (const e of ros.values()) e.avg = e.games ? e.total / e.games : 0;
  return { ros, weeks };
}

/**
 * Replacement level per position: the points per game of the best player a team could add for free.
 * That is the player just outside the starter pool, where the pool is every team's starting slots
 * (flex slots go to whichever RB/WR/TE are best once the fixed slots are filled).
 */
export function replacementLevels(
  ros: Ros,
  positionOf: (id: string) => string | undefined,
  slots: string[],
  teams: number,
): Record<string, number> {
  const byPos = new Map<string, { id: string; avg: number }[]>();
  for (const [id, e] of ros) {
    const pos = positionOf(id);
    if (pos && e.games > 0) byPos.set(pos, [...(byPos.get(pos) ?? []), { id, avg: e.avg }]);
  }
  for (const list of byPos.values()) list.sort((a, b) => b.avg - a.avg);

  const claimed: Record<string, number> = {};
  const starters = slots.filter((s) => s in SLOT_ELIGIBILITY);
  for (const pos of byPos.keys()) claimed[pos] = starters.filter((s) => s === pos).length * teams;

  // Flex slots, narrowest first, each taking the best players left over across the positions it accepts.
  const flex = starters.filter((s) => SLOT_ELIGIBILITY[s].length > 1).sort((a, b) => SLOT_ELIGIBILITY[a].length - SLOT_ELIGIBILITY[b].length);
  const flexTypes = [...new Set(flex)];
  for (const slot of flexTypes) {
    const count = flex.filter((s) => s === slot).length * teams;
    const leftovers = SLOT_ELIGIBILITY[slot].flatMap((pos) => (byPos.get(pos) ?? []).slice(claimed[pos] ?? 0, (claimed[pos] ?? 0) + count).map((p) => ({ ...p, pos })));
    leftovers.sort((a, b) => b.avg - a.avg);
    for (const p of leftovers.slice(0, count)) claimed[p.pos] = (claimed[p.pos] ?? 0) + 1;
  }

  const levels: Record<string, number> = {};
  for (const [pos, list] of byPos) {
    const n = claimed[pos] ?? 0;
    const window = list.slice(n, n + 3);
    levels[pos] = window.length ? window.reduce((s, p) => s + p.avg, 0) / window.length : list.length ? list[list.length - 1].avg : 0;
  }
  return levels;
}

/** Points above replacement over the remaining weeks (never negative: a player below replacement can be dropped). */
export function pointsAboveReplacement(e: RosEntry, replacement: number): number {
  let par = 0;
  for (const pts of e.weekly.values()) par += Math.max(0, pts - replacement);
  return par;
}

export interface OutlookPlayer {
  id: string;
  name: string;
  pos: string;
  injury?: string | null;
}

/**
 * Week-by-week lineup strength for a roster, and what byes cost.
 */
export function rosterOutlook(roster: OutlookPlayer[], ros: Ros, weeks: number[], slots: string[]) {
  return weeks.map((week) => {
    const playing: Candidate[] = [];
    const away: Candidate[] = []; // players on bye, at their usual points per game
    const onBye: string[] = [];
    for (const p of roster) {
      const e = ros.get(p.id);
      const pts = e?.weekly.get(week);
      if (pts !== undefined) playing.push({ id: p.id, pos: p.pos, pts });
      else if (e && e.games > 0) {
        onBye.push(p.name);
        away.push({ id: p.id, pos: p.pos, pts: e.avg });
      }
    }
    const best = optimalLineup(slots, playing);
    // What this week would look like if the players on bye had played: the gap is what the byes cost.
    const ifTheyPlayed = optimalLineup(slots, [...playing, ...away]).total;
    const empty = best.picks.filter((pk) => pk.player === null).map((pk) => pk.slot);
    return {
      week,
      lineup_projection: best.total,
      bye_cost: round(Math.max(0, ifTheyPlayed - best.total)),
      on_bye: onBye,
      empty_slots: empty.length ? empty : undefined,
    };
  });
}

/** Injury designations that mean a player is not expected to play soon. */
export const OUT_STATUSES = new Set(["IR", "Out", "PUP", "Sus", "NA", "DNR", "COV"]);

const RANKABLE = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** Shared by the Sleeper and Yahoo tools: every rankable player with rest-of-season totals and value over replacement. */
export function rankRos(
  ros: Ros,
  weeks: number[],
  levels: Record<string, number>,
  describe: (id: string) => { name: string; pos: string | undefined; team?: string | null; injury?: string | null } | null,
) {
  const rows = [];
  for (const [id, e] of ros) {
    const d = describe(id);
    if (!d || !d.pos || !RANKABLE.has(d.pos) || e.games === 0) continue;
    const par = pointsAboveReplacement(e, levels[d.pos] ?? 0);
    rows.push({
      id,
      name: d.name,
      pos: d.pos,
      team: d.team ?? undefined,
      injury: d.injury ?? undefined,
      par: round(par),
      ros_total: round(e.total),
      games: e.games,
      avg: round(e.avg),
      bye_weeks: weeks.filter((w) => !e.weekly.has(w)),
    });
  }
  return rows.sort((a, b) => b.par - a.par);
}

export const ROS_CAVEAT =
  "Rest-of-season numbers sum one RotoWire projection per future week, scored with your league's rules. Injuries are only reflected to the extent RotoWire has already built them in (some injured players show fewer games); role changes and new injuries are not. 'par' is points above a freely available replacement at the position; use it to compare players, not as a forecast of exact points.";
