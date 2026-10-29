# Fantasy Football Analyzer

An [MCP](https://modelcontextprotocol.io) server that lets Claude analyze your [Sleeper](https://sleeper.com) fantasy football leagues. Ask questions like *"Who should I start this week?"* or *"Who should I pick up, and what should I bid?"* and Claude answers using your live league data.

Built with TypeScript. Uses Sleeper's public read-only API, so no API key or login is needed, only your username.

## Tools

| Tool | What it does |
|---|---|
| `get_nfl_state` | Current NFL season and week |
| `get_my_leagues` | Your leagues and their ids |
| `get_league` | Scoring, starting slots, waiver and trade settings |
| `get_my_roster` | Starters, bench, IR and taxi, with injury status |
| `get_matchup` | Your head-to-head lineup vs your opponent |
| `get_league_rosters` | Every team's roster |
| `get_free_agents` | Unrostered players, ranked by Sleeper's search rank |
| `get_transactions` | Trades, waivers, and adds/drops for a week |
| `get_trending_players` | Most added/dropped players across Sleeper |
| `search_players` | Find a player by name |
| `get_lineup_analysis` | Your roster's projections under **your league's scoring**, plus the optimal lineup |
| `get_waiver_targets` | Free agents ranked by how much they'd improve your lineup |
| `get_chop_forecast` | Guillotine: probability each team is chopped this week, simulating what unplayed starters can still score |
| `get_bid_plan` | Guillotine: who will be on waivers, how much each would raise your lineup, what similar players cost in past chops, and the bid that maximizes expected surplus |
| `get_yahoo_league` | Yahoo: scoring rules, roster slots, playoff/trade settings, standings, FAAB balances |
| `get_yahoo_roster` | Yahoo: your roster with lineup slots, injury status, byes |
| `get_yahoo_matchup` | Yahoo: this week's head-to-head with both teams' points/projections and your opponent's roster |
| `get_yahoo_free_agents` | Yahoo: top unowned players |
| `get_yahoo_transactions` | Yahoo: recent adds, drops, trades |
| `get_yahoo_lineup_analysis` | Yahoo: your roster scored with your league's rules (RotoWire projections), best lineup vs current |
| `get_yahoo_waiver_targets` | Yahoo: free agents ranked by how much they'd raise your lineup, with usage trends |
| `get_ros_rankings` | Rest-of-season player values under your league's scoring: summed weekly projections and points above replacement |
| `get_roster_outlook` | Your roster week by week: lineup projection, who's on bye, empty slots, what byes cost |
| `get_yahoo_ros_rankings` | Yahoo: rest-of-season values under your Yahoo scoring |
| `get_yahoo_roster_outlook` | Yahoo: week-by-week lineup outlook and bye costs |
| `get_yahoo_league_rosters` | Yahoo: every team's roster, record, FAAB and a rest-of-season strength score |
| `evaluate_yahoo_trade` | Yahoo: grade a trade for both sides by best-lineup points over the rest of the season |
| `find_yahoo_trades` | Yahoo: search for 1-for-1, 2-for-1 and 1-for-2 trades that help both teams |
| `get_yahoo_pending_trades` | Yahoo: trades you proposed or were offered that are still waiting on a response |
| `get_usage_trends` | Weekly snap share, targets, carries and red-zone looks for players you name (or your roster), with a rising/falling signal |
| `get_usage_risers` | Free agents whose role is growing, with a warning for likely injury fill-ins |
| `get_projections` | League-scored projections for any players or position |
| `get_guillotine_status` | Guillotine leagues: chop history, survivors, distance to the chop line |
| `get_weekly_scoreboard` | Guillotine leagues: all surviving teams ranked for a week |
| `get_chopped_players` | Players released by chopped teams and whether they're still available |
| `get_faab_report` | Every team's remaining FAAB and bidding habits, plus past claim prices |

## Setup

Requires Node.js 20.12+.

```bash
git clone https://github.com/payneandrew/fantasy-football-analyzer.git
cd fantasy-football-analyzer
npm install
npm run build
```

Copy `.env.example` to `.env` and set `SLEEPER_USERNAME` to your Sleeper username. `.env` is gitignored.

Open the folder in [Claude Code](https://claude.com/claude-code) and approve the `sleeper` server (check status with `/mcp`). To use it with another MCP client, run `node build/index.js` over stdio with `SLEEPER_USERNAME` set in the environment.

Then try:

- *"List my leagues and show my roster."*
- *"Who should I start this week?"*
- *"Who should I pick up, and what should I bid?"*

## Run in the cloud (no computer needed)

A [Claude Code cloud session](https://code.claude.com/docs/en/claude-code-on-the-web) runs on Anthropic's servers, so you can use this from your phone without leaving a laptop on. The repo's `.mcp.json` is picked up automatically, and `scripts/start-mcp.sh` installs dependencies and builds on first start.

1. At [claude.ai/code](https://claude.ai/code), connect GitHub and give access to this repository.
2. Create an environment with:
   - **Network access:** Custom, with allowed domains `api.sleeper.app` and `api.sleeper.com`, and **Also include default list of common package managers** checked (needed for `npm`). The default Trusted list does not include Sleeper.
   - **Environment variables:** `SLEEPER_USERNAME=your_sleeper_username` (the environment is private to your account; do not put credentials here)
   - **Setup script** (optional, speeds up startup): `npm ci && npm run build`
3. Start a session on this repo (from the browser or the Code tab in the Claude mobile app) and ask, for example, *"List my Sleeper leagues."*

Yahoo tools need a local `.env` and token, so they are not available in cloud sessions.

## Development

```bash
npm run dev   # rebuild on change
```

After changing anything in `src/`, rebuild and restart the MCP server (`/mcp` in Claude Code).

## How it works

```
src/
  index.ts              MCP server entry point; registers each platform's tools
  env.ts                loads .env
  sleeper/
    client.ts           API client + daily on-disk cache of Sleeper's player database (.cache/)
    tools.ts            the MCP tool definitions
    usage.ts            snap share, targets/carries and team shares from weekly stats; rising/falling signal
    ros.ts              rest-of-season values: replacement levels, points above replacement, bye-week outlook
    projections.ts      fetches projections and past stats, rescores them with YOUR league's
                        scoring settings (Sleeper's generic totals often include bonuses your
                        league doesn't use), and computes optimal lineups
    guillotine.ts       guillotine-league standings and chop history
    forecast.ts         chop-probability simulation
    bids.ts             FAAB price models and bid sizing
    faab.ts             FAAB market analysis from transaction history
  yahoo/
    auth.ts, auth-cli.ts, client.ts   OAuth login and API client
    normalize.ts, league.ts           turns Yahoo's JSON into plain data; league/roster/matchup/free-agent readers
    trades.ts                         trade evaluation and search (lineup-aware, both sides)
    scoring.ts, match.ts, analysis.ts league scoring -> projection keys, Yahoo-to-Sleeper player matching, lineup and waiver analysis
    tools.ts                          the Yahoo MCP tools (registered only when YAHOO_CLIENT_ID is set)
    *.test.ts                         fixture tests: npm test
```

## Limitations

- Projections come from an **undocumented** Sleeper endpoint (RotoWire data). It is single-week only and could change without notice.
- Rest-of-season values sum future-week projections: they reflect injuries only as far as RotoWire has built them in, and there is no variance modeling yet.
- Yahoo's Fantasy Sports API requires approval (an application, a signed agreement, and a new app with the Fantasy Sports permission whose Client ID you submit to Yahoo). Yahoo exposes no projections, so the Yahoo analysis tools score Sleeper's RotoWire projections with your Yahoo league's own rules.
- Defense projections are approximate because expected values don't fit bracket scoring exactly.

## Disclaimer

Not affiliated with or endorsed by Sleeper. Uses only their public, read-only endpoints.

## License

[MIT](LICENSE)
