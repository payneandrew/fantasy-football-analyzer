import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sleeper, getPlayers } from "../sleeper/client.js";
import { getProjections } from "../sleeper/projections.js";
import { loadUsage, compactUsage } from "../sleeper/usage.js";
import { find, collect } from "./normalize.js";
import { buildMatcher } from "./match.js";
import { yahooScoring, yahooSlots } from "./scoring.js";
import { analyzeLineup, rankWaivers } from "./analysis.js";
import { getFreeAgents, getMyTeamKey, getRoster, getScoreboard, getSettings, getStandings, getTransactions } from "./league.js";

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
}
