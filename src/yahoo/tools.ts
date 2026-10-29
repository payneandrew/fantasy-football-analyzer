import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sleeper, getPlayers } from "../sleeper/client.js";
import { getProjections } from "../sleeper/projections.js";
import { loadUsage, compactUsage } from "../sleeper/usage.js";
import { find, collect } from "./normalize.js";
import { buildMatcher, normalizeName } from "./match.js";
import { yahooScoring, yahooSlots } from "./scoring.js";
import { analyzeLineup, rankWaivers } from "./analysis.js";
import { evaluateTrade, findTrades, seasonValue, type TradeSetup, type TradeTeam } from "./trades.js";
import { pointsAboveReplacement } from "../sleeper/ros.js";
import { loadRos, replacementLevels, rankRos, rosterOutlook, ROS_CAVEAT, OUT_STATUSES } from "../sleeper/ros.js";
import { getFreeAgents, getMyTeamKey, getPendingTrades, getRoster, getScoreboard, getSettings, getStandings, getTransactions } from "./league.js";

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const week = z.number().int().min(1).max(18).optional().describe("NFL week; defaults to the current week");
const POSITIONS = z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** League rules, projections and a player matcher, shared by the analysis tools. */
async function analysisContext(wk?: number) {
  const [settings, state, players, myTeam] = await Promise.all([getSettings(), sleeper.state(), getPlayers(), getMyTeamKey()]);
  const w = wk ?? state.week;
  const { scoring, readable, unmapped } = yahooScoring(settings);
  const proj = await getProjections(state.season, w);
  const slots = yahooSlots(settings);
  return { season: state.season, week: w, myTeam, scoring, readable, unmapped, input: { match: buildMatcher(players), players, proj, scoring, slots, week: w } };
}

export function registerYahooTools(server: McpServer) {
  server.registerTool(
    "get_yahoo_league",
    {
      description: "Your Yahoo league: scoring rules (as Yahoo defines them), roster slots, playoff and trade settings, and standings with each team's FAAB balance or waiver priority.",
      inputSchema: {},
    },
    async () => {
      const [settings, standings, me] = await Promise.all([getSettings(), getStandings(), getMyTeamKey()]);
      const s = yahooScoring(settings);
      const pick = (k: string) => find(settings, k);
      return text({
        you: me.name,
        scoring_type: pick("scoring_type"),
        teams: pick("num_teams"),
        roster_slots: collect(pick("roster_positions"), "position").map((p) => `${p.position} x${p.count}`),
        playoffs: { start_week: pick("playoff_start_week"), teams: pick("num_playoff_teams") },
        trade_end_date: pick("trade_end_date"),
        waivers: { type: pick("waiver_type"), uses_faab: pick("uses_faab"), rule: pick("waiver_rule") },
        scoring: s.readable,
        scoring_not_modeled: s.unmapped,
        standings,
      });
    },
  );

  server.registerTool(
    "get_yahoo_roster",
    { description: "Your Yahoo roster with lineup slots (QB, WR, BN, IR...), injury status and bye weeks.", inputSchema: { week } },
    async ({ week: wk }) => text((await getRoster((await getMyTeamKey()).key, wk)).map(({ key, id, eligible, ...p }) => p)),
  );

  server.registerTool(
    "get_yahoo_matchup",
    {
      description: "Your head-to-head matchup for a week: both teams' points and Yahoo's projected points, plus your opponent's roster.",
      inputSchema: { week },
    },
    async ({ week: wk }) => {
      const [board, me] = await Promise.all([getScoreboard(wk), getMyTeamKey()]);
      const game = board.matchups.find((m) => m.some((t) => t.team_key === me.key));
      if (!game) return text(`No matchup found for week ${board.week ?? wk}`);
      const opp = game.find((t) => t.team_key !== me.key);
      const oppRoster = opp ? (await getRoster(opp.team_key, wk)).map(({ key, id, eligible, ...p }) => p) : [];
      return text({ week: board.week, you: game.find((t) => t.team_key === me.key), opponent: opp, opponent_roster: oppRoster });
    },
  );

  server.registerTool(
    "get_yahoo_free_agents",
    {
      description: "Top unowned players in your Yahoo league. sort: AR = rank by this season's points (default), OR = overall rank, PTS = points.",
      inputSchema: { position: POSITIONS.optional(), count: z.number().int().min(1).max(50).default(25), sort: z.enum(["AR", "OR", "PTS"]).default("AR") },
    },
    async ({ position, count, sort }) => text((await getFreeAgents({ position, count, sort })).map(({ key, id, eligible, slot, ...p }) => p)),
  );

  server.registerTool(
    "get_yahoo_transactions",
    { description: "Recent adds, drops and trades in your Yahoo league.", inputSchema: { count: z.number().int().min(1).max(50).default(25) } },
    async ({ count }) => text(await getTransactions(count)),
  );

  server.registerTool(
    "get_yahoo_lineup_analysis",
    {
      description:
        "Your Yahoo roster scored with YOUR league's rules, using RotoWire projections from Sleeper's data (Yahoo's API doesn't expose projections). Compares your current lineup with the best one your roster could field and lists the swaps. Players that couldn't be matched are listed. Single-week projections.",
      inputSchema: { week },
    },
    async ({ week: wk }) => {
      const ctx = await analysisContext(wk);
      const [roster, board] = await Promise.all([getRoster(ctx.myTeam.key, ctx.week), getScoreboard(ctx.week).catch(() => null)]);
      const a = analyzeLineup(roster, ctx.input);
      const game = board?.matchups.find((m) => m.some((t) => t.team_key === ctx.myTeam.key));
      const { candidates, ...rest } = a;
      return text({
        week: ctx.week,
        ...rest,
        yahoo_projected_points: game?.map((t) => ({ team: t.team, projected: t.projected_points })),
        scoring_not_modeled: ctx.unmapped.length ? ctx.unmapped : undefined,
      });
    },
  );

  server.registerTool(
    "get_yahoo_waiver_targets",
    {
      description:
        "Yahoo free agents ranked by how much each would raise your best lineup this week (lineup_gain), scored with your league's rules, with usage trends (snap share, touches+targets). Also shows your FAAB balance or waiver priority. Single-week projections.",
      inputSchema: { position: POSITIONS.optional(), pool: z.number().int().min(10).max(50).default(40).describe("How many top free agents to evaluate"), limit: z.number().int().min(1).max(25).default(12), week },
    },
    async ({ position, pool, limit, week: wk }) => {
      const ctx = await analysisContext(wk);
      const [roster, free, standings, usage] = await Promise.all([
        getRoster(ctx.myTeam.key, ctx.week),
        getFreeAgents({ position, count: pool, sort: "AR" }),
        getStandings().catch(() => []),
        sleeper.state().then((s) => loadUsage(s.season, ctx.week - 1, 4, ctx.scoring)),
      ]);
      const ranked = rankWaivers(roster, free, ctx.input, limit);
      const mine = standings.find((t) => t.team_key === ctx.myTeam.key);
      return text({
        week: ctx.week,
        your_waiver_status: { faab_balance: mine?.faab_balance, waiver_priority: mine?.waiver_priority },
        ...ranked,
        targets: ranked.targets.map((t) => ({ ...t, usage: t.sleeper_id ? compactUsage(usage.summary(t.sleeper_id)) : undefined, sleeper_id: undefined })),
        note: "Free agents are the top of Yahoo's list by this season's points, not every available player.",
      });
    },
  );

  /** Rest-of-season data scored with the Yahoo league's rules, plus the helpers the two ROS tools share. */
  async function rosContext(throughWeek: number) {
    const [settings, state, players, myTeam] = await Promise.all([getSettings(), sleeper.state(), getPlayers(), getMyTeamKey()]);
    const { scoring, slots } = { scoring: yahooScoring(settings).scoring, slots: yahooSlots(settings) };
    const { ros, weeks } = await loadRos(state.season, state.week, throughWeek, scoring);
    const teams = Number(find(settings, "num_teams") ?? 12);
    const positionOf = (id: string) => (players[id] && (players[id].position === "DEF" || (players[id].status === "Active" && players[id].team)) ? players[id].position : undefined);
    return { players, myTeam, ros, weeks, slots, levels: replacementLevels(ros, positionOf, slots, teams), match: buildMatcher(players) };
  }

  server.registerTool(
    "get_yahoo_ros_rankings",
    {
      description: `Rest-of-season player values under YOUR Yahoo league's scoring: summed weekly projections (byes drop out) and points above replacement ('par'). Compare players for trades and pickups beyond this week. Ownership isn't shown (that needs every team's roster); 'mine' marks your players. ${ROS_CAVEAT}`,
      inputSchema: { position: POSITIONS.optional(), limit: z.number().int().min(1).max(50).default(20), include_injured: z.boolean().default(false).describe("Include players on IR, Out, PUP or suspended (excluded by default)"), through_week: z.number().int().min(1).max(18).default(17) },
    },
    async ({ position, limit, include_injured, through_week }) => {
      const c = await rosContext(through_week);
      const mine = new Set((await getRoster(c.myTeam.key)).map((p) => c.match(p)).filter(Boolean));
      const startable = new Set(c.slots.flatMap((s) => (s === "FLEX" ? ["RB", "WR", "TE"] : [s])));
      const rows = rankRos(c.ros, c.weeks, c.levels, (id) => {
        const p = c.players[id];
        return p && startable.has(p.position ?? "") ? { name: p.full_name ?? id, pos: p.position, team: p.team, injury: p.injury_status } : null;
      })
        .filter((r) => (!position || r.pos === position) && (include_injured || !OUT_STATUSES.has(r.injury ?? "")))
        .slice(0, limit)
        .map((r) => ({ ...r, mine: mine.has(r.id) || undefined, id: undefined }));
      return text({ weeks: `${c.weeks[0]}-${c.weeks[c.weeks.length - 1]}`, replacement_level_per_game: Object.fromEntries(Object.entries(c.levels).filter(([p]) => startable.has(p)).map(([p, v]) => [p, Math.round(v * 100) / 100])), players: rows, caveat: ROS_CAVEAT });
    },
  );

  server.registerTool(
    "get_yahoo_roster_outlook",
    {
      description: `Your Yahoo roster week by week for the rest of the season: best-lineup projection each week, who is on bye, empty starting slots, and bye_cost (points the byes cost you). Players in your IR slot are excluded. ${ROS_CAVEAT}`,
      inputSchema: { through_week: z.number().int().min(1).max(18).default(17) },
    },
    async ({ through_week }) => {
      const c = await rosContext(through_week);
      const roster = await getRoster(c.myTeam.key);
      const usable = roster.filter((p) => p.slot !== "IR");
      const outlookPlayers = usable.flatMap((p) => {
        const id = c.match(p);
        const pos = id ? c.players[id]?.position : undefined;
        return id && pos ? [{ id, name: p.name, pos, injury: p.status }] : [];
      });
      const outlook = rosterOutlook(outlookPlayers, c.ros, c.weeks, c.slots);
      const worst = [...outlook].sort((a, b) => b.bye_cost - a.bye_cost).slice(0, 3).filter((w) => w.bye_cost > 0);
      return text({
        weeks: `${c.weeks[0]}-${c.weeks[c.weeks.length - 1]}`,
        average_lineup_projection: Math.round((outlook.reduce((t, w) => t + w.lineup_projection, 0) / Math.max(1, outlook.length)) * 100) / 100,
        hardest_hit_by_byes: worst.map((w) => ({ week: w.week, bye_cost: w.bye_cost, on_bye: w.on_bye })),
        injured_now: usable.filter((p) => p.status).map((p) => `${p.name} (${p.status}${p.injury_note ? `: ${p.injury_note}` : ""})`),
        excluded: [...roster.filter((p) => p.slot === "IR").map((p) => `${p.name} (IR slot)`), ...usable.filter((p) => !c.match(p)).map((p) => `${p.name} (not matched)`)],
        by_week: outlook,
        caveat: ROS_CAVEAT,
      });
    },
  );


  /** Every team's roster with rest-of-season projections, plus the league setup the trade maths needs. */
  async function tradeContext(throughWeek: number, playoffWeight: number) {
    const c = await rosContext(throughWeek);
    const [settings, standings] = await Promise.all([getSettings(), getStandings()]);
    const playoffStart = Number(find(settings, "playoff_start_week") ?? 15);
    const maxRoster = collect(find(settings, "roster_positions"), "position")
      .filter((e) => !["IR", "NA"].includes(String(e.position)))
      .reduce((n, e) => n + Number(e.count ?? 1), 0);
    const setup: TradeSetup = {
      slots: c.slots,
      weeks: c.weeks,
      weight: (w) => (w >= playoffStart ? playoffWeight : 1),
      replacement: Object.fromEntries(Object.entries(c.levels).filter(([pos]) => c.slots.some((s) => s === pos || (s === "FLEX" && ["RB", "WR", "TE"].includes(pos))))),
      maxRoster,
    };
    const loaded = await Promise.all(standings.map(async (t) => ({ t, roster: await getRoster(t.team_key) })));
    const status = new Map<string, string>();
    const unmatched: string[] = [];
    const teams: TradeTeam[] = loaded.map(({ t, roster }) => ({
      key: t.team_key,
      name: t.team,
      players: roster
        .filter((p) => p.slot !== "IR")
        .flatMap((p) => {
          const id = c.match(p);
          const pos = id ? c.players[id]?.position : undefined;
          if (!id || !pos) {
            unmatched.push(`${p.name} (${t.team})`);
            return [];
          }
          const e = c.ros.get(id);
          if (p.status) status.set(id, `${p.status}${p.injury_note ? `: ${p.injury_note}` : ""}`);
          return [{ id, name: p.name, pos, weekly: e?.weekly ?? new Map(), total: e?.total ?? 0, par: e ? pointsAboveReplacement(e, setup.replacement[pos] ?? 0) : 0 }];
        }),
    }));
    const me = teams.find((t) => t.key === c.myTeam.key)!;
    return { c, setup, playoffStart, teams, me, standings, status, unmatched };
  }

  const weightArg = z.number().min(0).max(5).default(1).describe("How much playoff weeks count versus regular weeks (1 = equally)");

  server.registerTool(
    "get_yahoo_league_rosters",
    {
      description: `Every team in your Yahoo league: record, FAAB balance, a strength score (best-lineup points over the rest of the season, with free replacements filling gaps), and each roster with rest-of-season value. The starting point for finding trade partners. ${ROS_CAVEAT}`,
      inputSchema: { through_week: z.number().int().min(1).max(18).default(17) },
    },
    async ({ through_week }) => {
      const t = await tradeContext(through_week, 1);
      const rows = t.teams.map((team) => {
        const s = t.standings.find((x) => x.team_key === team.key);
        return {
          team: team.name,
          you: team.key === t.me.key || undefined,
          record: s?.record,
          rank: s?.rank,
          faab_balance: s?.faab_balance,
          strength: Math.round(seasonValue(team.players, t.setup).total),
          roster: [...team.players]
            .sort((a, b) => b.total - a.total)
            .map((p) => ({ name: p.name, pos: p.pos, par: Math.round(pointsAboveReplacement({ weekly: p.weekly, games: p.weekly.size, total: p.total, avg: 0 }, t.setup.replacement[p.pos] ?? 0)), health: t.status.get(p.id) })),
        };
      });
      rows.sort((a, b) => b.strength - a.strength);
      return text({ weeks: `${t.c.weeks[0]}-${t.c.weeks[t.c.weeks.length - 1]}`, teams: rows.map((r, i) => ({ strength_rank: i + 1, ...r })), unmatched_players: t.unmatched.length ? t.unmatched : undefined, caveat: ROS_CAVEAT });
    },
  );

  const locate = (teams: TradeTeam[], name: string, only?: TradeTeam) => {
    const needle = normalizeName(name);
    const pool = only ? [only] : teams;
    const hits = pool.flatMap((tm) => tm.players.filter((p) => normalizeName(p.name).includes(needle)).map((p) => ({ team: tm, player: p })));
    const exact = hits.filter((h) => normalizeName(h.player.name) === needle);
    const chosen = exact.length ? exact : hits;
    if (chosen.length === 0) throw new Error(`Couldn't find "${name}" on ${only ? only.name : "any team"}`);
    if (chosen.length > 1) throw new Error(`"${name}" is ambiguous: ${chosen.map((h) => `${h.player.name} (${h.team.name})`).join(", ")}`);
    return chosen[0];
  };

  server.registerTool(
    "evaluate_yahoo_trade",
    {
      description: `Grade a trade for BOTH sides. Each team's value is its best-lineup points over the rest of the season (weekly projections, byes handled, free replacements filling any gap), before and after. A trade only works if the other manager accepts, so check that 'them' gains too. Over the roster limit, the team drops its least valuable players (shown). I can't propose or submit trades: Yahoo's API is read-only, and your league votes on trades. ${ROS_CAVEAT}`,
      inputSchema: {
        give: z.array(z.string()).min(1).describe("Names of players on YOUR team you would give"),
        get: z.array(z.string()).min(1).describe("Names of players you would get; all from one team"),
        playoff_weight: weightArg,
        through_week: z.number().int().min(1).max(18).default(17),
      },
    },
    async ({ give, get, playoff_weight, through_week }) => {
      const t = await tradeContext(through_week, playoff_weight);
      const giveHits = give.map((n) => locate(t.teams, n, t.me));
      const getHits = get.map((n) => locate(t.teams.filter((x) => x.key !== t.me.key), n));
      const partner = getHits[0].team;
      if (getHits.some((h) => h.team.key !== partner.key)) throw new Error("All players you get must be on the same team");
      const result = evaluateTrade(t.me, partner, giveHits.map((h) => h.player.id), getHits.map((h) => h.player.id), t.setup, t.playoffStart);
      const health = getHits.map((h) => t.status.get(h.player.id)).some(Boolean) ? getHits.filter((h) => t.status.get(h.player.id)).map((h) => `${h.player.name}: ${t.status.get(h.player.id)}`) : undefined;
      return text({ ...result, health_of_players_you_get: health, both_sides_gain: result.you.change > 0 && result.them.change > 0, caveat: ROS_CAVEAT });
    },
  );

  server.registerTool(
    "find_yahoo_trades",
    {
      description: `Search your Yahoo league for trades that help BOTH you and the other team over the rest of the season (1-for-1, plus 2-for-1 and 1-for-2), ranked by how much they help you, with the other side's gain as a tiebreak toward trades that are easier to sell. Each result shows both sides' change and any injury on players you'd get. I can't submit trades; you'd propose them in Yahoo and your league votes. ${ROS_CAVEAT}`,
      inputSchema: {
        limit: z.number().int().min(1).max(15).default(8),
        min_your_gain: z.number().min(0).default(10).describe("Smallest rest-of-season gain for you, in points"),
        min_their_gain: z.number().min(-100).default(5).describe("Smallest change the other team must see. Negative values allow trades that cost them a little, which managers sometimes accept"),
        allow_two_for_one: z.boolean().default(true),
        partner: z.string().optional().describe("Only search this team (part of its name)"),
        max_value_gap: z.number().optional().describe("Only trades where you receive at most this many more points-above-replacement than you give. Small values (0-15) find trades that LOOK even to the other manager but favor your lineup, which is what they are likely to accept"),
        max_per_team: z.number().int().min(1).max(10).default(3).describe("Most trades listed per partner"),
        playoff_weight: weightArg,
        through_week: z.number().int().min(1).max(18).default(17),
      },
    },
    async ({ limit, min_your_gain, min_their_gain, allow_two_for_one, partner, max_value_gap, max_per_team, playoff_weight, through_week }) => {
      const t = await tradeContext(through_week, playoff_weight);
      let others = t.teams.filter((x) => x.key !== t.me.key);
      if (partner) others = others.filter((x) => x.name.toLowerCase().includes(partner.toLowerCase()));
      if (!others.length) throw new Error(`No team matches "${partner}"`);
      const found = findTrades(t.me, others, t.setup, t.playoffStart, { minYourGain: min_your_gain, minTheirGain: min_their_gain, limit, allowTwoForOne: allow_two_for_one, maxValueGap: max_value_gap, perTeam: max_per_team });
      const named = (names: string[], team: TradeTeam) => names.map((n) => team.players.find((p) => p.name === n)).filter(Boolean);
      return text({
        your_strength_now: Math.round(seasonValue(t.me.players, t.setup).total),
        searched_teams: others.length,
        trades: found.map((r) => {
          const theirTeam = t.teams.find((x) => x.name === r.them.team)!;
          const risky = named(r.you_get, theirTeam).filter((p) => t.status.has(p!.id)).map((p) => `${p!.name}: ${t.status.get(p!.id)}`);
          return { ...r, health_of_players_you_get: risky.length ? risky : undefined };
        }),
        note: found.length ? undefined : "No trade clears both thresholds. Try lowering min_their_gain or min_your_gain.",
        caveat: ROS_CAVEAT,
      });
    },
  );


  server.registerTool(
    "get_yahoo_pending_trades",
    {
      description: "Trades involving your team that are still waiting on a response: ones you proposed and ones offered to you, with every player and the drop each side attached. Use it to check on an offer.",
      inputSchema: {},
    },
    async () => {
      const trades = await getPendingTrades((await getMyTeamKey()).key);
      return text(trades.length ? trades : "No pending trades.");
    },
  );

}
