import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sleeper, getPlayers } from "../sleeper/client.js";
import { getProjections } from "../sleeper/projections.js";
import { loadUsage, compactUsage } from "../sleeper/usage.js";
import { find, collect } from "./normalize.js";
import { buildMatcher } from "./match.js";
import { yahooScoring, yahooSlots } from "./scoring.js";
import { analyzeLineup, rankWaivers } from "./analysis.js";
import { loadRos, replacementLevels, rankRos, rosterOutlook, ROS_CAVEAT, OUT_STATUSES } from "../sleeper/ros.js";
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

}
