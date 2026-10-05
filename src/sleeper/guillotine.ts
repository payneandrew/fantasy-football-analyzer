import { sleeper, type Roster, type LeagueUser } from "./client.js";

interface MatchupRow {
  roster_id: number;
  points: number;
}

export interface GuillotineState {
  isGuillotine: boolean;
  currentWeek: number;
  lastScoredWeek: number;
  scoring: Record<string, number>;
  rosters: Roster[];
  label: (rosterId: number) => string;
  /** week -> roster_id chopped at the end of that week */
  chops: Map<number, number>;
  /** week -> roster_id -> points */
  scores: Map<number, Map<number, number>>;
  /** week -> chopped transaction (drops = players released to the pool) */
  chopTransactions: Map<number, { drops: string[] }>;
  aliveIn: (week: number) => number[];
}

export async function loadGuillotine(leagueId: string): Promise<GuillotineState> {
  const [league, rosters, users] = await Promise.all([
    sleeper.get<any>(`/league/${leagueId}`),
    sleeper.get<Roster[]>(`/league/${leagueId}/rosters`),
    sleeper.get<LeagueUser[]>(`/league/${leagueId}/users`),
  ]);
  const currentWeek: number = league.settings?.leg ?? 1;
  const lastScoredWeek: number = league.settings?.last_scored_leg ?? 0;
  const weeks = Array.from({ length: Math.max(currentWeek, lastScoredWeek) }, (_, i) => i + 1);

  const [matchupsByWeek, txsByWeek] = await Promise.all([
    Promise.all(weeks.map((w) => sleeper.get<MatchupRow[]>(`/league/${leagueId}/matchups/${w}`))),
    Promise.all(weeks.map((w) => sleeper.get<any[]>(`/league/${leagueId}/transactions/${w}`))),
  ]);

  const scores = new Map<number, Map<number, number>>();
  weeks.forEach((w, i) => scores.set(w, new Map(matchupsByWeek[i].map((m) => [m.roster_id, m.points ?? 0]))));

  const chops = new Map<number, number>();
  const chopTransactions = new Map<number, { drops: string[] }>();
  weeks.forEach((w, i) => {
    const chop = txsByWeek[i].find((t) => t.type === "chopped" && t.status === "complete");
    if (chop) {
      chops.set(w, chop.roster_ids[0]);
      chopTransactions.set(w, { drops: Object.keys(chop.drops ?? {}) });
    }
  });

  const label = (rosterId: number) => {
    const r = rosters.find((x) => x.roster_id === rosterId);
    const u = users.find((x) => x.user_id === r?.owner_id);
    return u?.metadata?.team_name ?? u?.display_name ?? `Roster ${rosterId}`;
  };

  // A team plays week w unless it was chopped in an earlier week.
  const aliveIn = (week: number) => {
    const gone = new Set<number>();
    for (const [w, rid] of chops) if (w < week) gone.add(rid);
    return rosters.map((r) => r.roster_id).filter((id) => !gone.has(id));
  };

  return {
    isGuillotine: league.settings?.type === 3,
    currentWeek,
    lastScoredWeek,
    scoring: league.scoring_settings ?? {},
    rosters,
    label,
    chops,
    scores,
    chopTransactions,
    aliveIn,
  };
}

export const round = (n: number) => Math.round(n * 100) / 100;
