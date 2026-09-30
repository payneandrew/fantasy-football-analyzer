#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  USERNAME,
  sleeper,
  getPlayers,
  describePlayer,
  playerName,
  type Roster,
  type LeagueUser,
} from "./sleeper.js";
import { loadGuillotine, round } from "./guillotine.js";
import { loadFaab } from "./faab.js";
import { getProjections, recentPoints, scoreStats, optimalLineup, startablePositions, type Candidate } from "./projections.js";

const server = new McpServer({ name: "sleeper-fantasy", version: "0.1.0" });

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

async function currentSeasonAndWeek() {
  const s = await sleeper.state();
  return { season: s.season, week: s.week };
}

async function myRoster(leagueId: string) {
  const uid = await sleeper.userId();
  const rosters = await sleeper.get<Roster[]>(`/league/${leagueId}/rosters`);
  const mine = rosters.find((r) => r.owner_id === uid);
  if (!mine) throw new Error(`No roster owned by ${USERNAME} in league ${leagueId}`);
  return { mine, rosters };
}

server.registerTool(
  "get_nfl_state",
  { description: "Current NFL season, week and season type (preseason/regular/post).", inputSchema: {} },
  async () => text(await sleeper.state()),
);

server.registerTool(
  "get_my_leagues",
  {
    description: `List ${USERNAME}'s Sleeper leagues for a season, with league ids. Start here to get a league_id.`,
    inputSchema: { season: z.string().optional().describe("Defaults to the current NFL season") },
  },
  async ({ season }) => {
    const s = season ?? (await currentSeasonAndWeek()).season;
    const uid = await sleeper.userId();
    const leagues = await sleeper.get<any[]>(`/user/${uid}/leagues/nfl/${s}`);
    return text(
      leagues.map((l) => ({
        league_id: l.league_id,
        name: l.name,
        status: l.status,
        total_rosters: l.total_rosters,
        season: l.season,
      })),
    );
  },
);

server.registerTool(
  "get_league",
  {
    description:
      "League settings: roster positions (starting slots), scoring settings (PPR, passing TD points, etc.), waiver/trade settings. Needed to judge player value.",
    inputSchema: { league_id: z.string() },
  },
  async ({ league_id }) => {
    const l = await sleeper.get<any>(`/league/${league_id}`);
    return text({
      name: l.name,
      season: l.season,
      status: l.status,
      total_rosters: l.total_rosters,
      roster_positions: l.roster_positions,
      scoring_settings: l.scoring_settings,
      settings: {
        playoff_week_start: l.settings?.playoff_week_start,
        playoff_teams: l.settings?.playoff_teams,
        trade_deadline: l.settings?.trade_deadline,
        waiver_type: l.settings?.waiver_type,
        waiver_budget: l.settings?.waiver_budget,
        taxi_slots: l.settings?.taxi_slots,
        reserve_slots: l.settings?.reserve_slots,
      },
    });
  },
);

server.registerTool(
  "get_my_roster",
  {
    description: `${USERNAME}'s roster in a league: starters, bench, IR and taxi with names, positions, teams and injury status, plus record and points.`,
    inputSchema: { league_id: z.string() },
  },
  async ({ league_id }) => {
    const [{ mine }, players] = await Promise.all([myRoster(league_id), getPlayers()]);
    const starters = mine.starters ?? [];
    const bench = (mine.players ?? []).filter(
      (p) => !starters.includes(p) && !(mine.reserve ?? []).includes(p) && !(mine.taxi ?? []).includes(p),
    );
    const d = (ids: string[] | null) => (ids ?? []).map((id) => describePlayer(players, id));
    return text({
      roster_id: mine.roster_id,
      record: `${mine.settings.wins}-${mine.settings.losses}${mine.settings.ties ? `-${mine.settings.ties}` : ""}`,
      points_for: mine.settings.fpts + (mine.settings.fpts_decimal ?? 0) / 100,
      points_against: mine.settings.fpts_against,
      starters: d(starters),
      bench: d(bench),
      ir: d(mine.reserve),
      taxi: d(mine.taxi),
    });
  },
);

server.registerTool(
  "get_matchup",
  {
    description: "Your head-to-head matchup for a week: both lineups and current points. Defaults to the current week.",
    inputSchema: { league_id: z.string(), week: z.number().int().min(1).max(18).optional() },
  },
  async ({ league_id, week }) => {
    const w = week ?? (await currentSeasonAndWeek()).week;
    const [{ mine, rosters }, matchups, users, players] = await Promise.all([
      myRoster(league_id),
      sleeper.get<any[]>(`/league/${league_id}/matchups/${w}`),
      sleeper.get<LeagueUser[]>(`/league/${league_id}/users`),
      getPlayers(),
    ]);
    const me = matchups.find((m) => m.roster_id === mine.roster_id);
    if (!me) return text(`No matchup found for week ${w}`);
    const opp = matchups.find((m) => m.matchup_id === me.matchup_id && m.roster_id !== me.roster_id);
    const hint = opp ? undefined : "No opponent: this is likely a guillotine league. Use get_weekly_scoreboard / get_guillotine_status.";
    const label = (rosterId: number) => {
      const r = rosters.find((x) => x.roster_id === rosterId);
      const u = users.find((x) => x.user_id === r?.owner_id);
      return u?.metadata?.team_name ?? u?.display_name ?? `Roster ${rosterId}`;
    };
    const side = (m: any) => ({
      team: label(m.roster_id),
      points: m.points,
      starters: (m.starters as string[]).map((id, i) => ({
        ...describePlayer(players, id),
        points: m.starters_points?.[i],
      })),
    });
    return text({ week: w, me: side(me), opponent: opp ? side(opp) : null, hint });
  },
);

server.registerTool(
  "get_league_rosters",
  {
    description: "Every team in the league: owner, record, points, and full player list. Useful for trade targets and finding needs.",
    inputSchema: { league_id: z.string() },
  },
  async ({ league_id }) => {
    const [rosters, users, players] = await Promise.all([
      sleeper.get<Roster[]>(`/league/${league_id}/rosters`),
      sleeper.get<LeagueUser[]>(`/league/${league_id}/users`),
      getPlayers(),
    ]);
    return text(
      rosters.map((r) => {
        const u = users.find((x) => x.user_id === r.owner_id);
        return {
          roster_id: r.roster_id,
          owner: u?.display_name,
          team_name: u?.metadata?.team_name,
          record: `${r.settings.wins}-${r.settings.losses}`,
          points_for: r.settings.fpts + (r.settings.fpts_decimal ?? 0) / 100,
          players: (r.players ?? []).map((id) => {
            const p = describePlayer(players, id);
            return `${p.name} (${p.pos ?? "?"}, ${p.team ?? "FA"}${p.injury ? `, ${p.injury}` : ""})`;
          }),
        };
      }),
    );
  },
);

server.registerTool(
  "get_free_agents",
  {
    description:
      "Unrostered players in the league, ranked by Sleeper's overall search rank (a popularity/value proxy). Optionally filter by position.",
    inputSchema: {
      league_id: z.string(),
      position: z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ league_id, position, limit }) => {
    const [rosters, players] = await Promise.all([
      sleeper.get<Roster[]>(`/league/${league_id}/rosters`),
      getPlayers(),
    ]);
    const taken = new Set(rosters.flatMap((r) => r.players ?? []));
    const free = Object.values(players)
      .filter((p) => p.status === "Active" && p.team && !taken.has(p.player_id))
      .filter((p) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.position ?? ""))
      .filter((p) => !position || p.position === position)
      .sort((a, b) => (a.search_rank ?? 9e6) - (b.search_rank ?? 9e6))
      .slice(0, limit);
    return text(free.map((p) => describePlayer(players, p.player_id)));
  },
);

server.registerTool(
  "get_transactions",
  {
    description: "Trades, waiver claims and free-agent adds/drops in the league for a week (defaults to current week).",
    inputSchema: { league_id: z.string(), week: z.number().int().min(1).max(18).optional() },
  },
  async ({ league_id, week }) => {
    const w = week ?? (await currentSeasonAndWeek()).week;
    const [txs, users, rosters, players] = await Promise.all([
      sleeper.get<any[]>(`/league/${league_id}/transactions/${w}`),
      sleeper.get<LeagueUser[]>(`/league/${league_id}/users`),
      sleeper.get<Roster[]>(`/league/${league_id}/rosters`),
      getPlayers(),
    ]);
    const owner = (rid: number) => {
      const r = rosters.find((x) => x.roster_id === rid);
      return users.find((u) => u.user_id === r?.owner_id)?.display_name ?? `Roster ${rid}`;
    };
    const names = (m: Record<string, number> | null) =>
      Object.entries(m ?? {}).map(([id, rid]) => `${playerName(players[id], id)} -> ${owner(rid)}`);
    return text(
      txs
        .filter((t) => t.status === "complete")
        .map((t) => ({ type: t.type, adds: names(t.adds), drops: names(t.drops), waiver_bid: t.settings?.waiver_bid })),
    );
  },
);

server.registerTool(
  "get_trending_players",
  {
    description: "Players being added or dropped most across all Sleeper leagues recently. Good waiver-wire signal.",
    inputSchema: {
      type: z.enum(["add", "drop"]).default("add"),
      hours: z.number().int().min(1).max(168).default(24),
      limit: z.number().int().min(1).max(50).default(15),
    },
  },
  async ({ type, hours, limit }) => {
    const [trend, players] = await Promise.all([
      sleeper.get<{ player_id: string; count: number }[]>(
        `/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`,
      ),
      getPlayers(),
    ]);
    return text(trend.map((t) => ({ ...describePlayer(players, t.player_id), count: t.count })));
  },
);

server.registerTool(
  "search_players",
  {
    description: "Find NFL players by (partial) name. Returns id, position, team and injury status.",
    inputSchema: { query: z.string().min(2), limit: z.number().int().min(1).max(25).default(10) },
  },
  async ({ query, limit }) => {
    const players = await getPlayers();
    const q = query.toLowerCase();
    const hits = Object.values(players)
      .filter((p) => playerName(p, p.player_id).toLowerCase().includes(q))
      .sort((a, b) => (a.search_rank ?? 9e6) - (b.search_rank ?? 9e6))
      .slice(0, limit);
    return text(hits.map((p) => describePlayer(players, p.player_id)));
  },
);

server.registerTool(
  "get_guillotine_status",
  {
    description:
      "Guillotine-league overview: who was chopped each week (score and margin over the next-lowest team), the surviving teams ranked by total points, and where you stand relative to the chop line.",
    inputSchema: { league_id: z.string() },
  },
  async ({ league_id }) => {
    const g = await loadGuillotine(league_id);
    const uid = await sleeper.userId();
    const myId = g.rosters.find((r) => r.owner_id === uid)?.roster_id;

    const history = [...g.chops.entries()].map(([week, rid]) => {
      const ranked = g
        .aliveIn(week)
        .map((id) => ({ id, pts: g.scores.get(week)?.get(id) ?? 0 }))
        .sort((a, b) => a.pts - b.pts);
      const chopped = ranked.find((r) => r.id === rid)!;
      const next = ranked.find((r) => r.id !== rid)!;
      return {
        week,
        chopped: g.label(rid),
        chopped_points: round(chopped.pts),
        next_lowest: g.label(next.id),
        next_lowest_points: round(next.pts),
        margin: round(next.pts - chopped.pts),
      };
    });

    const alive = g.aliveIn(g.currentWeek);
    const completedWeeks = [...g.chops.keys()]; // weeks whose scores are final
    const standings = alive
      .map((id) => {
        const weekly = completedWeeks.map((w) => g.scores.get(w)?.get(id) ?? 0);
        const total = weekly.reduce((a, b) => a + b, 0);
        return {
          team: g.label(id),
          roster_id: id,
          total_points: round(total),
          avg: weekly.length ? round(total / weekly.length) : 0,
          lowest_week: weekly.length ? round(Math.min(...weekly)) : 0,
          you: id === myId || undefined,
        };
      })
      .sort((a, b) => b.total_points - a.total_points)
      .map((t, i) => ({ rank: i + 1, ...t }));

    // The chop line each week is the lowest score among survivors.
    const lines = history.map((h) => h.chopped_points);
    const mine = standings.find((t) => t.roster_id === myId);
    const live = alive
      .map((id) => ({ team: g.label(id), points: round(g.scores.get(g.currentWeek)?.get(id) ?? 0), you: id === myId || undefined }))
      .sort((a, b) => a.points - b.points);

    return text({
      is_guillotine: g.isGuillotine,
      current_week: g.currentWeek,
      teams_alive: alive.length,
      you_alive: myId !== undefined && alive.includes(myId),
      chop_history: history,
      chop_line_scores: lines,
      your_standing: mine && { rank: mine.rank, of: standings.length, avg: mine.avg, lowest_week: mine.lowest_week },
      standings,
      current_week_live_bottom_5: live.some((t) => t.points > 0) ? live.slice(0, 5) : "Week not started yet",
    });
  },
);

server.registerTool(
  "get_weekly_scoreboard",
  {
    description:
      "Guillotine scoreboard: all teams still alive that week ranked by points (lowest last = chop danger), with the chopped team marked and the gap to the bottom. Defaults to the current week.",
    inputSchema: { league_id: z.string(), week: z.number().int().min(1).max(18).optional() },
  },
  async ({ league_id, week }) => {
    const g = await loadGuillotine(league_id);
    const w = week ?? g.currentWeek;
    const uid = await sleeper.userId();
    const myId = g.rosters.find((r) => r.owner_id === uid)?.roster_id;
    const chopped = g.chops.get(w);
    const rows = g
      .aliveIn(w)
      .map((id) => ({ id, pts: g.scores.get(w)?.get(id) ?? 0 }))
      .sort((a, b) => b.pts - a.pts);
    if (!rows.some((r) => r.pts > 0)) return text(`Week ${w} has no scores yet (${rows.length} teams alive).`);
    const bottom = rows[rows.length - 1].pts;
    return text({
      week: w,
      final: chopped !== undefined,
      teams: rows.map((r, i) => ({
        rank: i + 1,
        team: g.label(r.id),
        points: round(r.pts),
        above_last_place: round(r.pts - bottom),
        status: r.id === chopped ? "CHOPPED" : r.id === myId ? "you" : undefined,
      })),
    });
  },
);

server.registerTool(
  "get_chopped_players",
  {
    description:
      "Players released when teams were chopped, and whether each is still available on waivers. The richest waiver source in a guillotine league. Defaults to all chops so far, best-ranked first.",
    inputSchema: {
      league_id: z.string(),
      week: z.number().int().min(1).max(18).optional().describe("Only the chop from this week"),
      position: z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ league_id, week, position, limit }) => {
    const [g, players] = await Promise.all([loadGuillotine(league_id), getPlayers()]);
    const taken = new Set(g.rosters.flatMap((r) => r.players ?? []));
    const out = [...g.chopTransactions.entries()]
      .filter(([w]) => !week || w === week)
      .flatMap(([w, t]) =>
        t.drops.map((id) => ({ ...describePlayer(players, id), chopped_team: g.label(g.chops.get(w)!), week: w, still_available: !taken.has(id) })),
      )
      .filter((p) => !position || p.pos === position)
      .sort((a, b) => (players[a.id]?.search_rank ?? 9e6) - (players[b.id]?.search_rank ?? 9e6))
      .slice(0, limit);
    return text(out);
  },
);

/** Shared setup for projection-based tools: league scoring, projections, and recent-form lookup. */
async function projectionContext(leagueId: string, week?: number) {
  const [league, state, players] = await Promise.all([
    sleeper.get<any>(`/league/${leagueId}`),
    sleeper.state(),
    getPlayers(),
  ]);
  const w = week ?? state.week;
  const scoring = league.scoring_settings as Record<string, number>;
  const [proj, form] = await Promise.all([getProjections(state.season, w), recentPoints(state.season, w, scoring)]);
  const row = (id: string) => {
    const pr = proj.get(id);
    const d = describePlayer(players, id);
    return {
      ...d,
      proj: pr ? scoreStats(pr.stats, scoring) : null,
      opp: pr?.opponent ?? undefined,
      ...form(id),
    };
  };
  return { league, week: w, players, proj, scoring, row, positions: league.roster_positions as string[] };
}

const lineupPool = (rows: ReturnType<Awaited<ReturnType<typeof projectionContext>>["row"]>[]): Candidate[] =>
  rows.filter((r) => r.proj !== null && r.pos).map((r) => ({ id: r.id, pos: r.pos!, pts: r.proj! }));

server.registerTool(
  "get_lineup_analysis",
  {
    description:
      "Your roster with projected points computed under THIS league's scoring, opponent, injury status and last-3-weeks form, plus the optimal lineup vs your current starters. Single-week projections (RotoWire via Sleeper); players with proj=null have no game/projection this week (bye, out, IR).",
    inputSchema: { league_id: z.string(), week: z.number().int().min(1).max(18).optional() },
  },
  async ({ league_id, week }) => {
    const [ctx, { mine }] = await Promise.all([projectionContext(league_id, week), myRoster(league_id)]);
    const starters = mine.starters ?? [];
    const rows = (mine.players ?? []).map((id) => ctx.row(id));
    const current = starters.map((id) => rows.find((r) => r.id === id)).filter((r) => r);
    const currentTotal = round(current.reduce((s, r) => s + (r!.proj ?? 0), 0));
    const best = optimalLineup(ctx.positions, lineupPool(rows));
    const starterIds = new Set(starters);
    const bestIds = new Set(best.picks.map((p) => p.player?.id));
    const nameOf = (id?: string) => rows.find((r) => r.id === id)?.name;
    return text({
      week: ctx.week,
      current_lineup_projection: currentTotal,
      optimal_lineup_projection: best.total,
      gain_from_optimizing: round(best.total - currentTotal),
      optimal_lineup: best.picks.map((p) => ({ slot: p.slot, player: p.player && nameOf(p.player.id), proj: p.player?.pts })),
      swaps_needed: {
        bench_in: [...bestIds].filter((id) => id && !starterIds.has(id)).map((id) => nameOf(id)),
        start_out: starters.filter((id) => !bestIds.has(id)).map((id) => nameOf(id)),
      },
      roster: rows.sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1)),
    });
  },
);

server.registerTool(
  "get_waiver_targets",
  {
    description:
      "Free agents ranked by how much they would raise YOUR optimal lineup this week (lineup_gain), using league-specific projections. Also shows projection, opponent, and last-3-weeks scoring for form/floor. Best for FAAB decisions.",
    inputSchema: {
      league_id: z.string(),
      position: z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]).optional(),
      limit: z.number().int().min(1).max(30).default(12),
      week: z.number().int().min(1).max(18).optional(),
    },
  },
  async ({ league_id, position, limit, week }) => {
    const [ctx, { mine, rosters }] = await Promise.all([projectionContext(league_id, week), myRoster(league_id)]);
    const taken = new Set(rosters.flatMap((r) => r.players ?? []));
    const startable = startablePositions(ctx.positions);
    const myPool = lineupPool((mine.players ?? []).map((id) => ctx.row(id)));
    const base = optimalLineup(ctx.positions, myPool).total;

    const scored = [...ctx.proj.keys()]
      .filter((id) => !taken.has(id))
      .map((id) => ctx.row(id))
      .filter((r) => r.proj !== null && r.proj > 0 && startable.has(r.pos ?? "") && (!position || r.pos === position))
      .sort((a, b) => b.proj! - a.proj!)
      .slice(0, 60)
      .map((r) => ({ ...r, lineup_gain: round(optimalLineup(ctx.positions, [...myPool, { id: r.id, pos: r.pos!, pts: r.proj! }]).total - base) }))
      .sort((a, b) => b.lineup_gain - a.lineup_gain || b.proj! - a.proj!)
      .slice(0, limit);

    return text({ week: ctx.week, your_optimal_lineup_projection: base, targets: scored });
  },
);

server.registerTool(
  "get_projections",
  {
    description:
      "League-scored projections for specific players (by name search or ids) or top players at a position. Use to compare start/sit or trade candidates on any roster.",
    inputSchema: {
      league_id: z.string(),
      player_ids: z.array(z.string()).optional(),
      position: z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      week: z.number().int().min(1).max(18).optional(),
    },
  },
  async ({ league_id, player_ids, position, limit, week }) => {
    const ctx = await projectionContext(league_id, week);
    const ids = player_ids ?? [...ctx.proj.keys()];
    const rows = ids
      .map((id) => ctx.row(id))
      .filter((r) => !position || r.pos === position)
      .sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1))
      .slice(0, limit);
    return text({ week: ctx.week, players: rows });
  },
);

server.registerTool(
  "get_faab_report",
  {
    description:
      "FAAB market intelligence: every surviving team's remaining budget and bidding habits (avg/biggest winning bid, how often they bid $100+, how much they overpaid vs the runner-up), plus the price history of past claims. Use to size bids on chopped-team players and predict who can outbid you.",
    inputSchema: {
      league_id: z.string(),
      chop_pool_only: z.boolean().default(false).describe("Only list past claims of players released in a chop"),
    },
  },
  async ({ league_id, chop_pool_only }) => {
    const f = await loadFaab(league_id);
    const uid = await sleeper.userId();
    const me = (await sleeper.get<Roster[]>(`/league/${league_id}/rosters`)).find((r) => r.owner_id === uid);
    const claims = f.results
      .filter((r) => r.winning_bid > 0 && (!chop_pool_only || r.chop_pool))
      .sort((a, b) => b.winning_bid - a.winning_bid)
      .slice(0, 25);
    const chop = f.results.filter((r) => r.chop_pool && r.winning_bid > 0);
    const rivals = f.teams.filter((t) => t.roster_id !== me?.roster_id);
    return text({
      total_budget: f.budget,
      your_remaining: f.teams.find((t) => t.roster_id === me?.roster_id)?.remaining,
      serious_rival_bidders: rivals
        .filter((t) => t.remaining >= 200 && (t.top_bids[0] ?? 0) >= 200)
        .map((t) => `${t.team}: $${t.remaining} left, highest past bid $${t.top_bids[0]}`),
      chop_pool_market: {
        claims: chop.length,
        avg_winning_bid: chop.length ? round(chop.reduce((s, r) => s + r.winning_bid, 0) / chop.length) : 0,
        avg_overpay_vs_runner_up: chop.length ? round(chop.reduce((s, r) => s + r.overpaid_by, 0) / chop.length) : 0,
      },
      teams: f.teams,
      top_claims: claims,
    });
  },
);

await server.connect(new StdioServerTransport());
console.error(`sleeper-fantasy MCP server running (user: ${USERNAME})`);
