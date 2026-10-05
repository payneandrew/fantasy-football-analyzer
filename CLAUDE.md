# Fantasy Football Analyzer

An MCP server (TypeScript) that gives Claude live access to the owner's fantasy football leagues, so Claude can act as an analyst: lineup decisions, waiver/FAAB bids, trades. The owner is a software developer who uses this from VS Code and from their phone (Claude Code cloud sessions).

## The owner's leagues

### Sleeper: "Dude Ranch Alums" (the main live data source)
- The Sleeper username comes from the `SLEEPER_USERNAME` environment variable (not stored in the repo). Find the league id by calling `get_my_leagues`.
- **Guillotine league**, 18 teams. There are no head-to-head opponents. Every week all surviving teams are ranked by points and the lowest scorer is "chopped" (eliminated). Survival is the goal, so floor matters more than ceiling. The last team standing wins.
- Chopped teams' whole rosters are released and become the FAAB pool. This is the main way to improve.
- Scoring: 0.5 PPR, 4-pt passing TD, 0.04/pass yd, -1 INT, 0.1/rush and rec yd, 6-pt TDs, -2 fumble lost. Lineup: QB, 2 RB, 2 WR, TE, 2 FLEX (RB/WR/TE), 6 bench, no K/DEF, no IR/taxi.
- **FAAB budget $1000.** Trades are disabled. Waivers and free agents are the only way to add players.
- Timing (observed over weeks 1-3): the chop is processed about 12:30 AM ET Tuesday, after Monday night. Claims clear about 3 AM ET Wednesday, so bids are placed during Tuesday. A team can be mathematically chopped on Monday night before Sleeper processes it. Compare the lowest score against what unplayed starters can still add.

### Yahoo: "Cargo Shorts": API access pending
- Traditional **12-team head-to-head** league, 0.5 PPR, **6-pt passing TD** (QBs are worth more than usual), 25 pass yds/pt, 10 yds/pt rush/rec, K and DEF included.
- Lineup: QB, 2 WR, 2 RB, TE, W/R/T, K, DEF, 7 bench, 1 IR. 6 of 12 teams make the playoffs (weeks 15-17). Trade deadline Nov 28. FAAB with a very small remaining budget, so trades are the main lever.
- Yahoo requires an approved application for its Fantasy API (since July 2026). The owner applied and was told to expect 1-2 weeks. Until approved, **the owner pastes roster/settings data into the chat.** The OAuth code in `src/yahoo/` works, but every API call returns 403 until approval. Yahoo tools are not built yet.
- Yahoo and Sleeper both use RotoWire projections. Rescoring Sleeper's stat lines with Yahoo's scoring rules matched Yahoo's displayed projections to within about 1 point.

## How to help

Prefer the MCP tools over guessing. Typical flows:
- **"Who should I start / what's my lineup?"** `get_lineup_analysis`
- **"Who should I pick up / bid on?"** For chop pools use `get_bid_plan` first (it runs the forecast, previews the pool, and sizes bids); `get_chop_forecast` answers "who's getting chopped?" on its own. For ordinary free agents use `get_waiver_targets` (ranks by `lineup_gain`). `get_chopped_players` and `get_faab_report` give the raw detail.
- **"Who is breaking out?" / evaluating a pickup or a player's role:** `get_usage_risers` (free agents) and `get_usage_trends` (specific players). Snap share and targets+carries lead points, so weigh them above last week's score. A big recent role with a tiny projection is usually an injury fill-in (the tools flag it in `caution`). Waiver and lineup tools also include a compact `usage` field.
- **"Where do I stand?"** `get_guillotine_status`, `get_weekly_scoreboard`
- Always call `get_my_leagues` first to get the league id. League ids and usernames are deliberately not stored in this repo.

Analysis conventions that came out of earlier sessions:
- `lineup_gain` is measured against the **current** lineup, one candidate at a time. Gains are **not additive**: if two targets would fill the same slot, the second is worth less once the first is added.
- `get_bid_plan` verdicts: "bid" has a realistic win chance, "long shot" is only worth placing because losing is free, "skip" isn't worth a claim. Its win probabilities rest on only a few past chops and are rough, so say so. `dollars_per_point` is the user's valuation knob; show `implied_dollars_per_point` so they can judge the price of a star.
- FAAB is sealed-bid and the bidder pays their own bid only if they win. A bid at one's true value costs nothing when it loses. Avoid round numbers (rivals cluster at $200); they overpay the runner-up by about $36 on average. Use `get_faab_report` for rivals' budgets and bidding history before sizing bids. Pace the budget: roughly one chop per week remains.
- Every claim needs a drop. Name specific drops.
- Be honest about uncertainty. Projections are single-week only, come from an undocumented Sleeper endpoint, and have no variance model. Say what was and wasn't checked, and don't invent details the data doesn't show.
- Today's date comes from the session. Check `get_nfl_state` for the current week rather than assuming.

## Codebase

- `src/index.ts`: server entry; registers each platform's tools.
- `src/env.ts`: loads `.env` (project-root relative; never overrides existing variables).
- `src/sleeper/`: `client.ts` (API client, daily on-disk player cache in `.cache/`), `tools.ts` (all Sleeper tool definitions), `projections.ts` (rescores projections with league scoring, optimal lineups), `usage.ts` (snap/target/carry usage and trends), `guillotine.ts`, `faab.ts`.
- `src/yahoo/`: `auth.ts` / `auth-cli.ts` (OAuth login via `npm run yahoo:auth`, tokens in `.cache/`), `client.ts`.
- `scripts/start-mcp.sh`: launches the server, installing and building first if needed (this is what `.mcp.json` runs, so a fresh clone or cloud session works).
- Build with `npm run build` (TypeScript, Node 20.12+). After changing `src/`, rebuild and restart the MCP server.
- Configuration: `SLEEPER_USERNAME` (required), plus `YAHOO_*` values, come from `.env` locally and from the environment's variables in a cloud session. See `.env.example`.
- Sleeper's API needs no auth. Cloud sessions must allow `api.sleeper.app` and `api.sleeper.com` in the environment's network settings.

## Rules

- **Never commit secrets or personal identifiers**: `.env`, `.cache/` (Yahoo tokens, certs), credentials, the owner's usernames and league ids stay out of git. They live in the local `.env` or in the cloud environment's variables.
- Don't commit or push unless the owner asks.
- Match the existing code style; keep comments sparse and explain *why*, not *what*.
