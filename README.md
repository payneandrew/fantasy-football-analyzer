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
| `get_projections` | League-scored projections for any players or position |
| `get_guillotine_status` | Guillotine leagues: chop history, survivors, distance to the chop line |
| `get_weekly_scoreboard` | Guillotine leagues: all surviving teams ranked for a week |
| `get_chopped_players` | Players released by chopped teams and whether they're still available |
| `get_faab_report` | Every team's remaining FAAB and bidding habits, plus past claim prices |

## Setup

Requires Node.js 18+.

```bash
git clone https://github.com/payneandrew/fantasy-football-analyzer.git
cd fantasy-football-analyzer
npm install
npm run build
```

Set your Sleeper username in [.mcp.json](.mcp.json):

```json
{
  "mcpServers": {
    "sleeper": {
      "command": "node",
      "args": ["build/index.js"],
      "env": { "SLEEPER_USERNAME": "your_sleeper_username" }
    }
  }
}
```

Open the folder in [Claude Code](https://claude.com/claude-code) and approve the `sleeper` server (check status with `/mcp`). To use it with another MCP client, run `node build/index.js` over stdio with `SLEEPER_USERNAME` set.

Then try:

- *"List my leagues and show my roster."*
- *"Who should I start this week?"*
- *"Who should I pick up, and what should I bid?"*

## Development

```bash
npm run dev   # rebuild on change
```

After changing anything in `src/`, rebuild and restart the MCP server (`/mcp` in Claude Code).

## How it works

- `src/sleeper.ts`: API client, plus a daily on-disk cache of Sleeper's large player database (`.cache/`).
- `src/projections.ts`: fetches projections and past stats, **rescores them with your league's own scoring settings** (Sleeper's generic point totals often include bonuses your league doesn't use), and computes optimal lineups.
- `src/guillotine.ts` / `src/faab.ts`: guillotine-league standings and FAAB market analysis built from matchup and transaction history.
- `src/index.ts`: the MCP server and tool definitions.

## Limitations

- Projections come from an **undocumented** Sleeper endpoint (RotoWire data). It is single-week only and could change without notice.
- No rest-of-season outlook or variance modeling yet.
- Sleeper only. Yahoo support is not implemented.
- Defense projections are approximate because expected values don't fit bracket scoring exactly.

## Disclaimer

Not affiliated with or endorsed by Sleeper. Uses only their public, read-only endpoints.

## License

[MIT](LICENSE)
