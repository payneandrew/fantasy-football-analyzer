import test from "node:test";
import assert from "node:assert/strict";
import { normalize, find, collect } from "./normalize.js";
import { playersIn, parseScoreboard, parseStandings, parseTransactions } from "./league.js";
import { yahooScoring, yahooSlots } from "./scoring.js";
import { buildMatcher, normalizeName } from "./match.js";

// Fixtures mirror the shapes Yahoo's JSON API returns (numbered-key lists, arrays of one-key objects).
const SETTINGS = {
  fantasy_content: {
    league: [
      { league_key: "461.l.123456", name: "Test League" },
      {
        settings: [
          {
            roster_positions: [
              { roster_position: { position: "QB", count: 1 } },
              { roster_position: { position: "WR", count: 2 } },
              { roster_position: { position: "W/R/T", count: 1 } },
              { roster_position: { position: "BN", count: 7 } },
            ],
            stat_categories: {
              stats: [
                { stat: { stat_id: 4, name: "Passing Yards", display_name: "Pass Yds" } },
                { stat: { stat_id: 5, name: "Passing Touchdowns" } },
                { stat: { stat_id: 6, name: "Interceptions" } },
                { stat: { stat_id: 11, name: "Receptions" } },
                { stat: { stat_id: 80, name: "2-Point Conversions" } },
                { stat: { stat_id: 57, name: "Extra Point Returned" } },
                { stat: { stat_id: 99, name: "Mystery Stat" } },
              ],
            },
            stat_modifiers: {
              stats: [
                { stat: { stat_id: 4, value: "0.04" } },
                { stat: { stat_id: 5, value: "6" } },
                { stat: { stat_id: 6, value: "-1" } },
                { stat: { stat_id: 11, value: "0.5" } },
                { stat: { stat_id: 80, value: "2" } },
                { stat: { stat_id: 57, value: "2" } },
                { stat: { stat_id: 99, value: "1" } },
              ],
            },
          },
        ],
      },
    ],
  },
};

const player = (key: string, name: string, team: string, pos: string, slot: string, extra: object[] = []) => ({
  player: [
    [{ player_key: key }, { player_id: key.split(".")[2] }, { name: { full: name } }, { editorial_team_abbr: team }, { display_position: pos }, { eligible_positions: [{ position: pos }] }, ...extra],
    { selected_position: [{ coverage_type: "week" }, { week: "5" }, { position: slot }] },
  ],
});

const ROSTER = {
  fantasy_content: {
    team: [
      [{ team_key: "461.l.123456.t.4" }, { name: "Team Alpha" }],
      { roster: { "0": { players: { "0": player("461.p.100", "Brock Purdy", "SF", "QB", "QB"), "1": player("461.p.200", "Nico Collins", "Hou", "WR", "BN", [{ status: "Q" }, { injury_note: "Knee" }]), count: 2 } } } },
    ],
  },
};

test("normalize turns numbered-key lists into arrays and merges one-key objects", () => {
  const n = normalize({ "0": { a: 1 }, "1": { a: 2 }, count: 2 });
  assert.deepEqual(n, [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(normalize([{ x: 1 }, { y: 2 }]), { x: 1, y: 2 });
  // repeated keys become a list
  assert.deepEqual(normalize([{ position: "QB" }, { position: "WR" }]), { position: ["QB", "WR"] });
});

test("find and collect search nested data", () => {
  const n = normalize(SETTINGS);
  assert.equal(find(n, "name"), "Test League");
  assert.equal(collect(find(n, "stat_modifiers"), "stat_id").length, 7);
});

test("playersIn reads roster players, slots, status and eligibility", () => {
  const ps = playersIn(ROSTER);
  assert.equal(ps.length, 2);
  assert.deepEqual([ps[0].name, ps[0].team, ps[0].position, ps[0].slot], ["Brock Purdy", "SF", "QB", "QB"]);
  assert.deepEqual([ps[1].name, ps[1].slot, ps[1].status, ps[1].injury_note], ["Nico Collins", "BN", "Q", "Knee"]);
  assert.deepEqual(ps[0].eligible, ["QB"]);
});

test("yahooScoring maps Yahoo stat names onto projection keys and reports what it can't", () => {
  const { scoring, readable, unmapped } = yahooScoring(normalize(SETTINGS));
  assert.equal(scoring.pass_yd, 0.04);
  assert.equal(scoring.pass_td, 6);
  assert.equal(scoring.pass_int, -1);
  assert.equal(scoring.rec, 0.5);
  assert.deepEqual([scoring.pass_2pt, scoring.rush_2pt, scoring.rec_2pt], [2, 2, 2]);
  assert.equal(readable["Passing Touchdowns"], 6);
  assert.deepEqual(unmapped, ["Mystery Stat"]); // "Extra Point Returned" is deliberately ignored
});

test("yahooSlots expands roster positions and maps W/R/T to FLEX", () => {
  assert.deepEqual(yahooSlots(normalize(SETTINGS)), ["QB", "WR", "WR", "FLEX", "BN", "BN", "BN", "BN", "BN", "BN", "BN"]);
});

test("name matching handles punctuation, suffixes, accents and team aliases", () => {
  assert.equal(normalizeName("Wan'Dale Robinson"), "wandale robinson");
  assert.equal(normalizeName("Chris Rodriguez Jr."), "chris rodriguez");
  const players: any = {
    "1": { player_id: "1", full_name: "Chris Rodriguez", position: "RB", team: "JAX", status: "Active" },
    "2": { player_id: "2", full_name: "Josh Allen", position: "QB", team: "BUF", status: "Active" },
    "3": { player_id: "3", full_name: "Josh Allen", position: "LB", team: "JAX", status: "Active" },
    MIN: { player_id: "MIN", position: "DEF", team: "MIN" },
  };
  const match = buildMatcher(players);
  const yp = (name: string, team: string, position: string) => ({ name, team, position }) as any;
  assert.equal(match(yp("Chris Rodriguez Jr.", "Jac", "RB")), "1");
  assert.equal(match(yp("Josh Allen", "Buf", "QB")), "2"); // two Josh Allens: team decides
  assert.equal(match(yp("Vikings", "Min", "DEF")), "MIN");
  assert.equal(match(yp("Nobody Real", "Buf", "WR")), null);
});

test("scoreboard and standings parse head-to-head data", () => {
  const sb = parseScoreboard({
    fantasy_content: {
      league: [
        { league_key: "461.l.123456" },
        {
          scoreboard: {
            week: "4",
            matchups: {
              "0": {
                matchup: {
                  week: "4",
                  teams: {
                    "0": { team: [[{ team_key: "461.l.123456.t.4" }, { name: "Alpha" }], { team_points: { coverage_type: "week", week: "4", total: "0.00" } }, { team_projected_points: { total: "106.95" } }] },
                    "1": { team: [[{ team_key: "461.l.123456.t.9" }, { name: "Beta" }], { team_points: { total: "0.00" } }, { team_projected_points: { total: "106.57" } }] },
                    count: 2,
                  },
                },
              },
              count: 1,
            },
          },
        },
      ],
    },
  });
  assert.equal(sb.week, 4);
  assert.equal(sb.matchups.length, 1);
  assert.deepEqual(sb.matchups[0].map((t) => [t.team, t.projected_points]), [["Alpha", 106.95], ["Beta", 106.57]]);

  const st = parseStandings({
    fantasy_content: { league: [{}, { standings: [{ teams: { "0": { team: [[{ team_key: "461.l.123456.t.4" }, { name: "Alpha" }, { waiver_priority: 7 }], { team_standings: { rank: "8", outcome_totals: { wins: 1, losses: 2, ties: 0 }, points_for: "326.56", points_against: "300.1" } }] }, count: 1 } }] }] },
  });
  assert.deepEqual([st[0].team, st[0].rank, st[0].record, st[0].points_for], ["Alpha", 8, "1-2", 326.56]);
});

import { analyzeLineup, rankWaivers } from "./analysis.js";

test("lineup analysis finds the better lineup and swaps; waiver ranking uses lineup gain", () => {
  const sp: any = {
    q1: { player_id: "q1", position: "QB", team: "SF", full_name: "Starter QB", status: "Active" },
    w1: { player_id: "w1", position: "WR", team: "HOU", full_name: "Good WR", status: "Active" },
    w2: { player_id: "w2", position: "WR", team: "DAL", full_name: "Bench WR", status: "Active" },
    w3: { player_id: "w3", position: "WR", team: "NE", full_name: "Free Agent WR", status: "Active" },
    w4: { player_id: "w4", position: "WR", team: "NYJ", full_name: "Bad Free Agent", status: "Active" },
  };
  const stats = (rec_yd: number) => ({ stats: { rec_yd }, opponent: "X", date: "2026-10-18", player_id: "" });
  const proj = new Map<string, any>([["q1", { stats: { pass_td: 2 } }], ["w1", stats(120)], ["w2", stats(40)], ["w3", stats(90)], ["w4", stats(10)]]);
  const input = { match: (p: any) => (p.name === "Mystery" ? null : sp[Object.keys(sp).find((k) => sp[k].full_name === p.name) ?? ""]?.player_id ?? null), players: sp, proj, scoring: { rec_yd: 0.1, pass_td: 6 }, slots: ["QB", "WR", "FLEX"] };
  const y = (name: string, slot: string, position: string) => ({ name, slot, position, team: null, status: null, injury_note: null, bye_week: null, eligible: [], key: name, id: name }) as any;
  // the bench WR is sitting while FLEX is empty-by-mistake: only one WR starts
  const roster = [y("Starter QB", "QB", "QB"), y("Good WR", "WR", "WR"), y("Bench WR", "BN", "WR"), y("Mystery", "BN", "WR")];
  const a = analyzeLineup(roster, input as any);
  assert.equal(a.optimal_lineup_projection, 12 + 12 + 4); // QB 2 TD = 12, Good WR 12, Bench WR fills FLEX at 4
  assert.equal(a.current_lineup_projection, 24);
  assert.deepEqual(a.swaps.bench_in, ["Bench WR"]);
  assert.deepEqual(a.unmatched, ["Mystery"]);

  const w = rankWaivers(roster, [y("Free Agent WR", "", "WR"), y("Bad Free Agent", "", "WR")], input as any);
  assert.equal(w.targets[0].name, "Free Agent WR");
  assert.equal(w.targets[0].lineup_gain, 5); // replaces the 4-pt FLEX with 9
  assert.equal(w.targets.find((t) => t.name === "Bad Free Agent")?.lineup_gain, 0);
});

test("transactions list each add and drop with the team involved", () => {
  const tx = parseTransactions({
    fantasy_content: {
      league: [
        {},
        {
          transactions: {
            "0": {
              transaction: [
                { transaction_key: "470.l.123456.tr.257", type: "add/drop", status: "successful", timestamp: "1793268373" },
                {
                  players: {
                    "0": { player: [[{ player_key: "470.p.1" }, { name: { full: "Kendrick Bourne" } }, { editorial_team_abbr: "Ari" }, { display_position: "WR" }, { transaction_data: [{ type: "add", source_type: "freeagents", destination_type: "team", destination_team_name: "Team Gamma" }] }]] },
                    "1": { player: [[{ player_key: "470.p.2" }, { name: { full: "MarShawn Lloyd" } }, { editorial_team_abbr: "GB" }, { display_position: "RB" }, { transaction_data: [{ type: "drop", source_type: "team", source_team_name: "Team Gamma", destination_type: "waivers" }] }]] },
                    count: 2,
                  },
                },
              ],
            },
            count: 1,
          },
        },
      ],
    },
  });
  assert.equal(tx.length, 1);
  assert.deepEqual(tx[0].moves.map((m) => [m.action, m.player, m.team]), [["add", "Kendrick Bourne (WR, Ari)", "Team Gamma"], ["drop", "MarShawn Lloyd (RB, GB)", "Team Gamma"]]);
});
