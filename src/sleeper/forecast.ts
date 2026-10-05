import { sleeper, getPlayers, playerName } from "./client.js";
import { loadGuillotine, round, type GuillotineState } from "./guillotine.js";
import { getProjections, scoreStats } from "./projections.js";

const TRIALS = 20000;

export interface RemainingStarter {
  name: string;
  expected_remaining: number;
  game_date: string;
}

export interface TeamForecast {
  roster_id: number;
  team: string;
  points_now: number;
  expected_remaining: number;
  expected_final: number;
  chop_probability: number;
  remaining_starters: RemainingStarter[];
}

export interface ChopForecast {
  week: number;
  /** true once Sleeper has processed this week's chop */
  processed: boolean;
  chopped_roster_id?: number;
  teams: TeamForecast[];
  most_likely: { roster_id: number; team: string; probability: number };
  /** probability >= 99.5% */
  locked: boolean;
  trials: number;
}

// Small seeded PRNG so repeated calls give identical numbers.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Monte Carlo: how often each team finishes last, given points so far and the spread of what is still to come. */
export function simulateChop(teams: { now: number; mean: number; sd: number }[], seed: number): number[] {
  const rand = mulberry32(seed);
  const wins = new Array(teams.length).fill(0);
  for (let t = 0; t < TRIALS; t++) {
    let worst = 0;
    let worstScore = Infinity;
    teams.forEach((tm, i) => {
      const final = tm.now + (tm.sd > 0 ? Math.max(0, tm.mean + tm.sd * gaussian(rand)) : 0);
      if (final < worstScore) {
        worstScore = final;
        worst = i;
      }
    });
    wins[worst]++;
  }
  return wins.map((w) => w / TRIALS);
}

/**
 * Who will be chopped this week? Takes each surviving team's points so far plus what its unplayed
 * starters can still add, then simulates the rest of the week.
 *
 * A starter's remaining points are: nothing if his game date is before today, his full projection if the
 * game is after today, and (projection - points so far) if it is today, since a game today may be in
 * progress or finished. That last case is deliberately generous to teams, so a "locked" result is safe.
 */
export async function forecastChop(leagueId: string, g?: GuillotineState): Promise<ChopForecast> {
  g ??= await loadGuillotine(leagueId);
  const week = g.currentWeek;
  const [state, players, matchups] = await Promise.all([
    sleeper.state(),
    getPlayers(),
    sleeper.get<any[]>(`/league/${leagueId}/matchups/${week}`),
  ]);
  const proj = await getProjections(state.season, week);
  const today = todayET();
  const alive = g.aliveIn(week);
  const processedRoster = g.chops.get(week);

  const teams = alive.map((rosterId) => {
    const m = matchups.find((x) => x.roster_id === rosterId);
    const starters: string[] = m?.starters ?? [];
    const points: number[] = m?.starters_points ?? [];
    const remaining: RemainingStarter[] = [];
    let sdSq = 0;
    starters.forEach((id, i) => {
      if (!id || id === "0") return;
      const pr = proj.get(id);
      if (!pr?.date) return; // no game: bye, inactive, or no projection
      const projected = scoreStats(pr.stats, g!.scoring);
      const sofar = points[i] ?? 0;
      const rem = pr.date < today ? 0 : pr.date > today ? projected : Math.max(0, projected - sofar);
      if (rem <= 0.05) return;
      remaining.push({ name: playerName(players[id], id), expected_remaining: round(rem), game_date: pr.date });
      const sd = Math.max(2.5, 0.55 * rem); // football scoring is very spread out game to game
      sdSq += sd * sd;
    });
    const mean = remaining.reduce((s, r) => s + r.expected_remaining, 0);
    return { rosterId, now: m?.points ?? 0, mean, sd: Math.sqrt(sdSq), remaining };
  });

  const wins = simulateChop(teams, week * 7919 + alive.length);

  const out: TeamForecast[] = teams
    .map((tm, i) => ({
      roster_id: tm.rosterId,
      team: g!.label(tm.rosterId),
      points_now: round(tm.now),
      expected_remaining: round(tm.mean),
      expected_final: round(tm.now + tm.mean),
      chop_probability: processedRoster !== undefined ? Number(tm.rosterId === processedRoster) : wins[i],
      remaining_starters: tm.remaining,
    }))
    .sort((a, b) => b.chop_probability - a.chop_probability || a.expected_final - b.expected_final);

  const top = out[0];
  return {
    week,
    processed: processedRoster !== undefined,
    chopped_roster_id: processedRoster,
    teams: out,
    most_likely: { roster_id: top.roster_id, team: top.team, probability: round(top.chop_probability) },
    locked: top.chop_probability >= 0.995,
    trials: TRIALS,
  };
}
