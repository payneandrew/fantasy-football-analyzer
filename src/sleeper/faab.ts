import { sleeper, getPlayers, playerName, type Roster, type LeagueUser } from "./client.js";
import { round } from "./guillotine.js";

interface Bid {
  week: number;
  rosterId: number;
  playerId: string;
  amount: number;
  won: boolean;
  /** true if the claim lost specifically to another owner's higher bid (as opposed to an invalid claim) */
  competing: boolean;
  chopPool: boolean;
}

export async function loadFaab(leagueId: string) {
  const [league, rosters, users, players] = await Promise.all([
    sleeper.get<any>(`/league/${leagueId}`),
    sleeper.get<Roster[]>(`/league/${leagueId}/rosters`),
    sleeper.get<LeagueUser[]>(`/league/${leagueId}/users`),
    getPlayers(),
  ]);
  const budget: number = league.settings?.waiver_budget ?? 0;
  const weeks = Array.from({ length: league.settings?.leg ?? 1 }, (_, i) => i + 1);
  const txsByWeek = await Promise.all(weeks.map((w) => sleeper.get<any[]>(`/league/${leagueId}/transactions/${w}`)));

  const label = (rid: number) => {
    const r = rosters.find((x) => x.roster_id === rid);
    const u = users.find((x) => x.user_id === r?.owner_id);
    return u?.display_name ?? `Roster ${rid}`;
  };

  const bids: Bid[] = [];
  const choppedIds = new Set<number>();
  weeks.forEach((week, i) => {
    const txs = txsByWeek[i];
    const chopPool = new Set(txs.filter((t) => t.type === "chopped").flatMap((t) => Object.keys(t.drops ?? {})));
    for (const t of txs.filter((t) => t.type === "chopped")) choppedIds.add(t.roster_ids[0]);
    for (const t of txs) {
      if (t.type !== "waiver") continue;
      const playerId = Object.keys(t.adds ?? {})[0];
      if (!playerId) continue;
      const won = t.status === "complete";
      const lostToOwner = t.status === "failed" && /another owner/i.test(t.metadata?.notes ?? "");
      if (!won && !lostToOwner) continue;
      bids.push({
        week,
        rosterId: t.roster_ids[0],
        playerId,
        amount: t.settings?.waiver_bid ?? 0,
        won,
        competing: lostToOwner,
        chopPool: chopPool.has(playerId),
      });
    }
  });

  // Group into auctions: one per (week, player). Winner vs runner-up gives the true clearing margin.
  const auctions = new Map<string, Bid[]>();
  for (const b of bids) {
    const k = `${b.week}:${b.playerId}`;
    auctions.set(k, [...(auctions.get(k) ?? []), b]);
  }
  const results = [...auctions.values()]
    .map((list) => {
      const winner = list.find((b) => b.won);
      if (!winner) return null;
      const losers = list.filter((b) => !b.won).sort((a, b) => b.amount - a.amount);
      const runnerUp = losers[0]?.amount;
      return {
        week: winner.week,
        player_id: winner.playerId,
        player: playerName(players[winner.playerId], winner.playerId),
        winner: label(winner.rosterId),
        winner_id: winner.rosterId,
        winning_bid: winner.amount,
        runner_up_bid: runnerUp ?? null,
        bidders: list.length,
        overpaid_by: runnerUp === undefined ? 0 : Math.max(0, winner.amount - (runnerUp + 1)),
        chop_pool: winner.chopPool,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const teams = rosters
    .filter((r) => !choppedIds.has(r.roster_id))
    .map((r) => {
      const mine = bids.filter((b) => b.rosterId === r.roster_id);
      const wins = results.filter((x) => x.winner_id === r.roster_id);
      const paid = wins.reduce((s, x) => s + x.winning_bid, 0);
      const used = r.settings.waiver_budget_used ?? paid;
      return {
        roster_id: r.roster_id,
        team: label(r.roster_id),
        remaining: budget - used,
        spent: used,
        claims_won: wins.length,
        avg_winning_bid: wins.length ? round(paid / wins.length) : 0,
        biggest_win: wins.length ? Math.max(...wins.map((x) => x.winning_bid)) : 0,
        bids_of_100_plus: mine.filter((b) => b.amount >= 100).length,
        top_bids: mine.map((b) => b.amount).sort((a, b) => b - a).slice(0, 4),
        total_overpaid: wins.reduce((s, x) => s + x.overpaid_by, 0),
        waiver_priority: r.settings.waiver_position,
      };
    })
    .sort((a, b) => b.remaining - a.remaining);

  return { budget, teams, results, label };
}
