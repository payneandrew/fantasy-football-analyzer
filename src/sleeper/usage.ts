import { getWeekStatRows, scoreStats, type Scoring } from "./projections.js";
import { round } from "./guillotine.js";

// A snap-share swing this big (percentage points) or this many more touches+targets per game counts as a trend.
const SNAP_TREND_PP = 10;
const OPP_TREND = 3;

export type Signal = "rising" | "falling" | "mixed" | "stable" | "insufficient data";

export interface UsageWeek {
  week: number;
  snap_pct: number | null;
  targets: number;
  carries: number;
  /** targets + carries */
  opps: number;
  target_share: number | null;
  carry_share: number | null;
  /** red-zone targets + red-zone carries */
  rz_opps: number;
  air_yards: number;
  points: number;
}

export interface UsageSummary {
  games: number;
  recent_snap_pct: number | null;
  /** recent snap share minus earlier snap share, in percentage points */
  snap_trend_pp: number | null;
  recent_opps: number | null;
  /** recent opportunities per game minus earlier */
  opp_trend: number | null;
  avg_target_share: number | null;
  avg_carry_share: number | null;
  rz_opps_per_game: number;
  avg_points: number | null;
  signal: Signal;
}

const n = (s: Record<string, number>, k: string) => s[k] ?? 0;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanOrNull = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? mean(v) : null;
};

/**
 * Usage (snap share, targets, carries, red-zone looks) for the `weeks` completed weeks ending at `throughWeek`.
 * Shares are measured against the player's NFL team totals for that week.
 */
export async function loadUsage(season: string, throughWeek: number, weeks: number, scoring: Scoring) {
  const weekNums: number[] = [];
  for (let w = Math.max(1, throughWeek - weeks + 1); w <= throughWeek; w++) weekNums.push(w);

  const data = await Promise.all(
    weekNums.map(async (week) => {
      const rows = await getWeekStatRows(season, week);
      const teams = new Map<string, { tgt: number; car: number }>();
      for (const r of rows.values()) {
        if (!r.team) continue;
        const t = teams.get(r.team) ?? { tgt: 0, car: 0 };
        t.tgt += n(r.stats, "rec_tgt");
        t.car += n(r.stats, "rush_att");
        teams.set(r.team, t);
      }
      return { week, rows, teams };
    }),
  );

  const weekly = (id: string): UsageWeek[] =>
    data.flatMap(({ week, rows, teams }) => {
      const row = rows.get(id);
      if (!row || !(n(row.stats, "gp") > 0)) return [];
      const s = row.stats;
      const snaps = n(s, "off_snp");
      const tgt = n(s, "rec_tgt");
      const car = n(s, "rush_att");
      if (!snaps && !tgt && !car) return []; // on the roster but didn't play
      const team = row.team ? teams.get(row.team) : undefined;
      const teamSnaps = n(s, "tm_off_snp");
      return [
        {
          week,
          snap_pct: teamSnaps > 0 ? round((100 * snaps) / teamSnaps) : null,
          targets: tgt,
          carries: car,
          opps: tgt + car,
          target_share: team && team.tgt > 0 ? round((100 * tgt) / team.tgt) : null,
          carry_share: team && team.car > 0 ? round((100 * car) / team.car) : null,
          rz_opps: n(s, "rec_rz_tgt") + n(s, "rush_rz_att"),
          air_yards: n(s, "rec_air_yd"),
          points: scoreStats(s, scoring),
        },
      ];
    });

  const summarize = (played: UsageWeek[]): UsageSummary => {
    const games = played.length;
    // With 4+ games compare the last two against the earlier ones; with fewer, the last game against the earlier ones.
    const recentN = games >= 4 ? 2 : 1;
    const recent = played.slice(games - recentN);
    const earlier = played.slice(0, games - recentN);
    const canTrend = games >= 2;
    const snapRecent = meanOrNull(recent.map((w) => w.snap_pct));
    const snapEarlier = meanOrNull(earlier.map((w) => w.snap_pct));
    const oppRecent = recent.length ? mean(recent.map((w) => w.opps)) : null;
    const oppEarlier = earlier.length ? mean(earlier.map((w) => w.opps)) : null;
    const snapTrend = canTrend && snapRecent !== null && snapEarlier !== null ? snapRecent - snapEarlier : null;
    const oppTrend = canTrend && oppRecent !== null && oppEarlier !== null ? oppRecent - oppEarlier : null;

    const up = (snapTrend ?? 0) >= SNAP_TREND_PP || (oppTrend ?? 0) >= OPP_TREND;
    const down = (snapTrend ?? 0) <= -SNAP_TREND_PP || (oppTrend ?? 0) <= -OPP_TREND;
    const signal: Signal = !canTrend ? "insufficient data" : up && down ? "mixed" : up ? "rising" : down ? "falling" : "stable";

    const r = (x: number | null) => (x === null ? null : round(x));
    return {
      games,
      recent_snap_pct: r(snapRecent),
      snap_trend_pp: r(snapTrend),
      recent_opps: r(oppRecent),
      opp_trend: r(oppTrend),
      avg_target_share: r(meanOrNull(played.map((w) => w.target_share))),
      avg_carry_share: r(meanOrNull(played.map((w) => w.carry_share))),
      rz_opps_per_game: games ? round(mean(played.map((w) => w.rz_opps))) : 0,
      avg_points: games ? round(mean(played.map((w) => w.points))) : null,
      signal,
    };
  };

  const allIds = new Set<string>();
  for (const { rows } of data) for (const id of rows.keys()) allIds.add(id);

  return {
    weeks: weekNums,
    weekly,
    summary: (id: string) => summarize(weekly(id)),
    /** every player id with stats in the window */
    playerIds: () => [...allIds],
  };
}

/** Compact one-line-per-player view for embedding in other tools' output. */
export const compactUsage = (u: UsageSummary | null) =>
  u && u.games > 0
    ? { snap_pct: u.recent_snap_pct, opps_per_game: u.recent_opps, trend: u.signal, rz_per_game: u.rz_opps_per_game }
    : undefined;
