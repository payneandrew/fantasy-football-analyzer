import type { Player } from "../sleeper/client.js";
import { optimalLineup, scoreStats, type Candidate, type Projection } from "../sleeper/projections.js";
import type { YahooPlayer } from "./league.js";

const BENCH_SLOTS = new Set(["BN", "IR", "IR+", "NA"]);
const round = (n: number) => Math.round(n * 100) / 100;

export interface AnalysisInput {
  /** maps a Yahoo player to a Sleeper player id (null if unknown) */
  match: (p: YahooPlayer) => string | null;
  players: Record<string, Player>;
  proj: Map<string, Projection>;
  scoring: Record<string, number>;
  /** starting slots, e.g. ["QB","WR","WR","FLEX","K","DEF"] */
  slots: string[];
  /** the NFL week being analyzed, used to flag players on bye */
  week?: number;
}

export interface ScoredPlayer {
  name: string;
  team: string | null;
  position: string;
  slot: string | null;
  status: string | null;
  injury_note: string | null;
  bye_week: number | null;
  /** true when this player's team is on bye in the week being analyzed (so a 0 projection is expected) */
  on_bye: boolean;
  sleeper_id: string | null;
  /** projected points this week under THIS league's scoring; null when there is no projection (bye, out, unmatched) */
  proj: number | null;
}

export function scorePlayer(p: YahooPlayer, input: AnalysisInput): ScoredPlayer {
  const id = input.match(p);
  const pr = id ? input.proj.get(id) : undefined;
  return {
    name: p.name,
    team: p.team,
    position: p.position,
    slot: p.slot,
    status: p.status,
    injury_note: p.injury_note,
    bye_week: p.bye_week,
    on_bye: input.week !== undefined && p.bye_week === input.week,
    sleeper_id: id,
    proj: pr ? scoreStats(pr.stats, input.scoring) : null,
  };
}

const toCandidate = (s: ScoredPlayer, input: AnalysisInput): Candidate | null => {
  const pos = s.sleeper_id ? input.players[s.sleeper_id]?.position : undefined;
  return s.proj !== null && pos ? { id: s.sleeper_id!, pos, pts: s.proj } : null;
};

/** Your current lineup vs the best lineup the same roster could field. */
export function analyzeLineup(roster: YahooPlayer[], input: AnalysisInput) {
  const scored = roster.map((p) => scorePlayer(p, input));
  const candidates = scored.map((s) => toCandidate(s, input)).filter((c): c is Candidate => c !== null);
  const starters = scored.filter((s) => s.slot && !BENCH_SLOTS.has(s.slot));
  const best = optimalLineup(input.slots, candidates);
  const startingIds = new Set(starters.map((s) => s.sleeper_id));
  const bestIds = new Set(best.picks.map((p) => p.player?.id));
  const nameOf = (id?: string | null) => scored.find((s) => s.sleeper_id === id)?.name;
  const current = round(starters.reduce((t, s) => t + (s.proj ?? 0), 0));
  return {
    current_lineup_projection: current,
    optimal_lineup_projection: best.total,
    gain_from_optimizing: round(best.total - current),
    optimal_lineup: best.picks.map((p) => ({ slot: p.slot, player: p.player ? nameOf(p.player.id) : null, proj: p.player?.pts ?? null })),
    swaps: {
      bench_in: [...bestIds].filter((id) => id && !startingIds.has(id)).map((id) => nameOf(id)),
      start_out: starters.filter((s) => !bestIds.has(s.sleeper_id ?? undefined)).map((s) => s.name),
    },
    roster: scored.sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1)),
    unmatched: scored.filter((s) => !s.sleeper_id).map((s) => s.name),
    candidates,
  };
}

/** Free agents ranked by how much each would raise the best lineup you could field. */
export function rankWaivers(roster: YahooPlayer[], freeAgents: YahooPlayer[], input: AnalysisInput, limit = 12) {
  const mine = analyzeLineup(roster, input);
  const base = mine.optimal_lineup_projection;
  const ranked = freeAgents
    .map((fa) => scorePlayer(fa, input))
    .map((s) => ({ s, c: toCandidate(s, input) }))
    .filter((x): x is { s: ScoredPlayer; c: Candidate } => x.c !== null && x.c.pts > 0)
    .map(({ s, c }) => ({ ...s, lineup_gain: round(optimalLineup(input.slots, [...mine.candidates, c]).total - base) }))
    .sort((a, b) => b.lineup_gain - a.lineup_gain || (b.proj ?? 0) - (a.proj ?? 0))
    .slice(0, limit);
  return { your_optimal_lineup_projection: base, targets: ranked, unmatched: freeAgents.filter((p) => !input.match(p)).map((p) => p.name) };
}
