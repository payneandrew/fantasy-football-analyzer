import { optimalLineup, type Candidate } from "../sleeper/projections.js";
import { round } from "../sleeper/guillotine.js";

export interface TeamPlayer {
  id: string;
  name: string;
  pos: string;
  /** projected points for each remaining week the player has a game */
  weekly: Map<number, number>;
  total: number;
  /** rest-of-season points above a free replacement: the 'raw value' a manager sees in a player */
  par: number;
}

export interface TradeTeam {
  key: string;
  name: string;
  players: TeamPlayer[];
}

export interface TradeSetup {
  slots: string[];
  weeks: number[];
  /** weight per week, e.g. playoff weeks count more */
  weight: (week: number) => number;
  /** free-agent level per position (points per game); fills any lineup gap */
  replacement: Record<string, number>;
  /** most players a team can hold outside IR */
  maxRoster: number;
}

const REPLACEMENTS_PER_POSITION = 3;

/** A team's best-lineup points summed over the remaining weeks, weighted, with free replacements filling gaps. */
export function seasonValue(players: TeamPlayer[], setup: TradeSetup): { total: number; byWeek: Map<number, number> } {
  const repl: Candidate[] = Object.entries(setup.replacement).flatMap(([pos, pts]) =>
    Array.from({ length: REPLACEMENTS_PER_POSITION }, (_, i) => ({ id: `REPL_${pos}_${i}`, pos, pts })),
  );
  const byWeek = new Map<number, number>();
  let total = 0;
  for (const week of setup.weeks) {
    const pool: Candidate[] = [...repl];
    for (const p of players) {
      const pts = p.weekly.get(week);
      if (pts !== undefined) pool.push({ id: p.id, pos: p.pos, pts });
    }
    const v = optimalLineup(setup.slots, pool).total;
    byWeek.set(week, v);
    total += v * setup.weight(week);
  }
  return { total, byWeek };
}

const without = (players: TeamPlayer[], ids: Set<string>) => players.filter((p) => !ids.has(p.id));

/** Over the roster limit a team drops its least valuable players (lowest rest-of-season total). */
function trim(players: TeamPlayer[], max: number): { kept: TeamPlayer[]; dropped: TeamPlayer[] } {
  if (players.length <= max) return { kept: players, dropped: [] };
  const sorted = [...players].sort((a, b) => b.total - a.total);
  return { kept: sorted.slice(0, max), dropped: sorted.slice(max) };
}

export interface TradeResult {
  you_give: string[];
  you_get: string[];
  /** raw value (points above replacement) of what each side hands over: a trade that looks even here but isn't in the lineup is the easiest to sell */
  value: { you_give: number; you_get: number };
  you: { before: number; after: number; change: number; playoff_change: number; drops?: string[] };
  them: { team: string; before: number; after: number; change: number; playoff_change: number; drops?: string[] };
}

/** Weeks from `from` on: used to report what a trade does to the playoffs alone. */
const tail = (m: Map<number, number>, from: number) => [...m].filter(([w]) => w >= from).reduce((s, [, v]) => s + v, 0);

export function evaluateTrade(me: TradeTeam, them: TradeTeam, giveIds: string[], getIds: string[], setup: TradeSetup, playoffStart: number): TradeResult {
  const give = new Set(giveIds);
  const get = new Set(getIds);
  const giving = me.players.filter((p) => give.has(p.id));
  const getting = them.players.filter((p) => get.has(p.id));

  const myTrim = trim([...without(me.players, give), ...getting], setup.maxRoster);
  const theirTrim = trim([...without(them.players, get), ...giving], setup.maxRoster);

  const myBefore = seasonValue(me.players, setup);
  const myAfter = seasonValue(myTrim.kept, setup);
  const theirBefore = seasonValue(them.players, setup);
  const theirAfter = seasonValue(theirTrim.kept, setup);

  return {
    you_give: giving.map((p) => p.name),
    you_get: getting.map((p) => p.name),
    value: { you_give: round(giving.reduce((t, p) => t + p.par, 0)), you_get: round(getting.reduce((t, p) => t + p.par, 0)) },
    you: {
      before: round(myBefore.total),
      after: round(myAfter.total),
      change: round(myAfter.total - myBefore.total),
      playoff_change: round(tail(myAfter.byWeek, playoffStart) - tail(myBefore.byWeek, playoffStart)),
      drops: myTrim.dropped.length ? myTrim.dropped.map((p) => p.name) : undefined,
    },
    them: {
      team: them.name,
      before: round(theirBefore.total),
      after: round(theirAfter.total),
      change: round(theirAfter.total - theirBefore.total),
      playoff_change: round(tail(theirAfter.byWeek, playoffStart) - tail(theirBefore.byWeek, playoffStart)),
      drops: theirTrim.dropped.length ? theirTrim.dropped.map((p) => p.name) : undefined,
    },
  };
}

const combos = <T,>(items: T[], size: number): T[][] => {
  if (size === 1) return items.map((i) => [i]);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) out.push([items[i], items[j]]);
  return out;
};

export interface FindOptions {
  /** smallest rest-of-season gain, in points, either side must see */
  minYourGain: number;
  minTheirGain: number;
  limit: number;
  /** also try swapping two of yours for one of theirs, and one for two */
  allowTwoForOne: boolean;
  /** skip trades where you receive more than this much raw value beyond what you give (leave unset for no limit) */
  maxValueGap?: number;
  /** most trades to return per partner, so one team can't fill the list */
  perTeam?: number;
}

/**
 * Search trades that help both sides. A trade only works if the other manager says yes, so it must raise
 * their best-lineup points too. Ranked by how much it helps you, with the smaller of the two gains breaking ties
 * toward trades that are easier to sell.
 */
export function findTrades(me: TradeTeam, others: TradeTeam[], setup: TradeSetup, playoffStart: number, opts: FindOptions): TradeResult[] {
  const myBase = seasonValue(me.players, setup).total;
  const tradable = (t: TradeTeam) => t.players.filter((p) => p.weekly.size > 0).sort((a, b) => b.total - a.total).slice(0, 12);
  const myPool = tradable(me);
  const proposals: (TradeResult & { score: number; key: string })[] = [];

  for (const them of others) {
    const theirBase = seasonValue(them.players, setup).total;
    const theirPool = tradable(them);
    const shapes: [number, number][] = [[1, 1]];
    if (opts.allowTwoForOne) shapes.push([2, 1], [1, 2]);
    for (const [g, r] of shapes) {
      for (const giveSet of combos(myPool, g)) {
        for (const getSet of combos(theirPool, r)) {
          const give = new Set(giveSet.map((p) => p.id));
          const get = new Set(getSet.map((p) => p.id));
          if (opts.maxValueGap !== undefined) {
            const gap = getSet.reduce((t, p) => t + p.par, 0) - giveSet.reduce((t, p) => t + p.par, 0);
            if (gap > opts.maxValueGap) continue;
          }
          const myTrim = trim([...without(me.players, give), ...getSet], setup.maxRoster);
          const myGain = seasonValue(myTrim.kept, setup).total - myBase;
          if (myGain < opts.minYourGain) continue; // cheap filter before valuing the other side
          const theirTrim = trim([...without(them.players, get), ...giveSet], setup.maxRoster);
          const theirGain = seasonValue(theirTrim.kept, setup).total - theirBase;
          if (theirGain < opts.minTheirGain) continue;
          const result = evaluateTrade(me, them, [...give], [...get], setup, playoffStart);
          // Equal-effect throw-ins cost you nothing, so among them lean toward the one worth more to the other side.
          const sweetener = 0.001 * giveSet.reduce((t, p) => t + p.total, 0);
          proposals.push({ ...result, score: myGain + Math.min(myGain, theirGain) + sweetener, key: `${them.key}|${[...get].sort().join(",")}` });
        }
      }
    }
  }
  // One entry per package of players you would get: the same targets with different throw-ins are one trade.
  const best = new Map<string, (typeof proposals)[number]>();
  for (const p of proposals) if (!best.has(p.key) || p.score > best.get(p.key)!.score) best.set(p.key, p);
  const perTeam = new Map<string, number>();
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .filter((p) => {
      const n = (perTeam.get(p.them.team) ?? 0) + 1;
      perTeam.set(p.them.team, n);
      return n <= (opts.perTeam ?? Infinity);
    })
    .slice(0, opts.limit)
    .map(({ score, key, ...r }) => r);
}
