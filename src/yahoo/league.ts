import { yahooConfig } from "./auth.js";
import { yahooGet } from "./client.js";
import { normalize, asArray, find, collect } from "./normalize.js";

let gameKeyMemo: string | null = null;

/** The current NFL game's key (it changes every season). */
export async function getGameKey(): Promise<string> {
  if (gameKeyMemo) return gameKeyMemo;
  const key = find(normalize(await yahooGet("game/nfl")), "game_key");
  if (!key) throw new Error("Could not determine Yahoo's current NFL game key");
  return (gameKeyMemo = String(key));
}

export async function getLeagueKey(): Promise<string> {
  const { leagueId } = yahooConfig();
  if (!leagueId) throw new Error("YAHOO_LEAGUE_ID is not set (see .env.example)");
  return `${await getGameKey()}.l.${leagueId}`;
}

export interface YahooPlayer {
  key: string;
  id: string;
  name: string;
  team: string | null;
  /** e.g. "WR" or "RB,WR" */
  position: string;
  eligible: string[];
  /** lineup slot this week (BN, IR, QB, ...) when the player is on a roster */
  slot: string | null;
  /** Yahoo injury/status designation: Q, D, O, IR, NA, ... */
  status: string | null;
  injury_note: string | null;
  bye_week: number | null;
}

/** Turn one normalized player entity into a flat record. */
export function toPlayer(p: any): YahooPlayer {
  const sel = find(p, "selected_position");
  const position = Array.isArray(sel) ? sel[sel.length - 1]?.position : sel?.position;
  const eligible = asArray(find(p, "eligible_positions")).flatMap((e: any) => (typeof e === "string" ? e : asArray(e?.position)));
  const bye = find(p, "bye_weeks")?.week ?? find(p, "bye_weeks");
  return {
    key: String(p.player_key ?? ""),
    id: String(p.player_id ?? ""),
    name: p.name?.full ?? p.name ?? "",
    team: p.editorial_team_abbr ?? null,
    position: String(p.display_position ?? ""),
    eligible: eligible.map(String),
    slot: position ?? null,
    status: p.status || null,
    injury_note: p.injury_note || null,
    bye_week: bye !== undefined && !Number.isNaN(Number(bye)) ? Number(bye) : null,
  };
}

export const playersIn = (node: unknown): YahooPlayer[] => collect(normalize(node), "player_key").map(toPlayer);

/** The signed-in user's team in the configured league. */
export async function getMyTeamKey(): Promise<{ key: string; name: string }> {
  const leagueKey = await getLeagueKey();
  const raw = normalize(await yahooGet(`users;use_login=1/games;game_keys=${await getGameKey()}/teams`));
  const mine = collect(raw, "team_key").find((t) => String(t.team_key).startsWith(`${leagueKey}.t.`));
  if (!mine) throw new Error(`No team of yours found in league ${leagueKey}. Is YAHOO_LEAGUE_ID right?`);
  return { key: String(mine.team_key), name: String(mine.name ?? "") };
}

export async function getSettings() {
  return normalize(await yahooGet(`league/${await getLeagueKey()}/settings`));
}

export async function getStandings() {
  return parseStandings(await yahooGet(`league/${await getLeagueKey()}/standings`));
}

export function parseStandings(response: unknown) {
  return collect(normalize(response), "team_key").map((t) => {
    const s = t.team_standings ?? {};
    return {
      team_key: String(t.team_key),
      team: String(t.name ?? ""),
      rank: Number(s.rank ?? 0),
      record: `${s.outcome_totals?.wins ?? 0}-${s.outcome_totals?.losses ?? 0}${Number(s.outcome_totals?.ties) ? `-${s.outcome_totals.ties}` : ""}`,
      points_for: Number(s.points_for ?? 0),
      points_against: Number(s.points_against ?? 0),
      waiver_priority: t.waiver_priority !== undefined ? Number(t.waiver_priority) : undefined,
      faab_balance: t.faab_balance !== undefined ? Number(t.faab_balance) : undefined,
    };
  });
}

export async function getRoster(teamKey: string, week?: number): Promise<YahooPlayer[]> {
  const path = `team/${teamKey}/roster${week ? `;week=${week}` : ""}/players`;
  return playersIn(await yahooGet(path));
}

export interface MatchupTeam {
  team_key: string;
  team: string;
  points: number | null;
  projected_points: number | null;
}

export async function getScoreboard(week?: number) {
  return parseScoreboard(await yahooGet(`league/${await getLeagueKey()}/scoreboard${week ? `;week=${week}` : ""}`));
}

export function parseScoreboard(response: unknown): { week: number | null; matchups: MatchupTeam[][] } {
  const raw = normalize(response);
  // Finished matchups also carry `matchup_grades` entries with team keys, so read only the `teams` list.
  const matchups = asArray(find(raw, "matchups")).map((m: any) =>
    collect(find(m, "teams") ?? m, "team_key").filter((t) => t.name !== undefined).map((t) => ({
      team_key: String(t.team_key),
      team: String(t.name ?? ""),
      points: t.team_points?.total !== undefined ? Number(t.team_points.total) : null,
      projected_points: t.team_projected_points?.total !== undefined ? Number(t.team_projected_points.total) : null,
    })),
  );
  const w = find(raw, "week");
  return { week: w !== undefined ? Number(w) : null, matchups };
}

/** Top unowned players. `sort` is a Yahoo sort code: AR = actual rank this season, OR = overall rank, PTS = points. */
export async function getFreeAgents(opts: { position?: string; count?: number; start?: number; sort?: string } = {}) {
  const parts = ["status=A", opts.position && `position=${opts.position}`, `sort=${opts.sort ?? "AR"}`, `start=${opts.start ?? 0}`, `count=${opts.count ?? 25}`].filter(Boolean);
  return playersIn(await yahooGet(`league/${await getLeagueKey()}/players;${parts.join(";")}`));
}

export async function getTransactions(count = 25) {
  return parseTransactions(await yahooGet(`league/${await getLeagueKey()}/transactions;count=${count}`));
}

export function parseTransactions(response: unknown) {
  return collect(normalize(response), "transaction_key").map((t) => ({
    type: t.type,
    status: t.status,
    timestamp: t.timestamp ? new Date(Number(t.timestamp) * 1000).toISOString() : undefined,
    faab_bid: t.faab_bid !== undefined ? Number(t.faab_bid) : undefined,
    // Each player carries its own add/drop/trade record, with the team it came from or went to.
    moves: collect(t.players, "player_key").map((p) => {
      const d = p.transaction_data ?? {};
      return {
        action: d.type,
        player: `${p.name?.full ?? p.player_key} (${p.display_position}, ${p.editorial_team_abbr})`,
        team: d.destination_team_name ?? d.source_team_name,
        from: d.source_type,
        to: d.destination_type,
      };
    }),
  }));
}

/** Trades you have proposed or been offered that are still waiting on a response. */
export async function getPendingTrades(teamKey: string) {
  return parseTransactions(await yahooGet(`team/${teamKey}/transactions;types=pending_trade`));
}
