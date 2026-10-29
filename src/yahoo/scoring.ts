import { find, collect } from "./normalize.js";

// Yahoo stat name (lowercased, letters and digits only) -> the keys in Sleeper's projection stat lines.
const SLEEPER_KEYS: Record<string, string[]> = {
  passingyards: ["pass_yd"],
  passingtouchdowns: ["pass_td"],
  interceptions: ["pass_int"],
  rushingyards: ["rush_yd"],
  rushingtouchdowns: ["rush_td"],
  receptions: ["rec"],
  receivingyards: ["rec_yd"],
  receivingtouchdowns: ["rec_td"],
  returntouchdowns: ["st_td"],
  "2pointconversions": ["pass_2pt", "rush_2pt", "rec_2pt"],
  fumbleslost: ["fum_lost"],
  offensivefumblereturntd: ["fum_rec_td"],
  fieldgoals019yards: ["fgm_0_19"],
  fieldgoals2029yards: ["fgm_20_29"],
  fieldgoals3039yards: ["fgm_30_39"],
  fieldgoals4049yards: ["fgm_40_49"],
  fieldgoals50yards: ["fgm_50p"],
  fieldgoalsmissed019yards: ["fgmiss_0_19"],
  fieldgoalsmissed2029yards: ["fgmiss_20_29"],
  fieldgoalsmissed3039yards: ["fgmiss_30_39"],
  fieldgoalsmissed4049yards: ["fgmiss_40_49"],
  fieldgoalsmissed50yards: ["fgmiss_50p"],
  pointafterattemptmade: ["xpm"],
  pointafterattemptmissed: ["xpmiss"],
  sack: ["sack"],
  interception: ["int"],
  fumblerecovery: ["fum_rec"],
  touchdown: ["def_td"],
  safety: ["safe"],
  blockkick: ["blk_kick"],
  kickoffandpuntreturntouchdowns: ["def_st_td"],
  pointsallowed0points: ["pts_allow_0"],
  pointsallowed16points: ["pts_allow_1_6"],
  pointsallowed713points: ["pts_allow_7_13"],
  pointsallowed1420points: ["pts_allow_14_20"],
  pointsallowed2127points: ["pts_allow_21_27"],
  pointsallowed2834points: ["pts_allow_28_34"],
  pointsallowed35points: ["pts_allow_35p"],
};

// Stats Yahoo scores that Sleeper's projections have no equivalent for. Rare, so they cost almost nothing.
const IGNORABLE = new Set(["extrapointreturned"]);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface YahooScoring {
  /** Sleeper-style scoring dict that `scoreStats` understands */
  scoring: Record<string, number>;
  /** stat name -> points per unit, as Yahoo reports them */
  readable: Record<string, number>;
  /** scored stats this tool can't translate; their points are missing from projections */
  unmapped: string[];
}

/** Build scoring from the normalized `league/.../settings` response. */
export function yahooScoring(settings: unknown): YahooScoring {
  const names = new Map<string, string>();
  for (const s of collect(find(settings, "stat_categories"), "stat_id")) names.set(String(s.stat_id), String(s.name ?? s.display_name ?? ""));

  const scoring: Record<string, number> = {};
  const readable: Record<string, number> = {};
  const unmapped: string[] = [];
  for (const m of collect(find(settings, "stat_modifiers"), "stat_id")) {
    const name = names.get(String(m.stat_id)) ?? `stat ${m.stat_id}`;
    const value = Number(m.value);
    if (!Number.isFinite(value) || value === 0) continue;
    readable[name] = value;
    const keys = SLEEPER_KEYS[squash(name)];
    if (keys) for (const k of keys) scoring[k] = value;
    else if (!IGNORABLE.has(squash(name))) unmapped.push(name);
  }
  return { scoring, readable, unmapped };
}

/** Starting slots for `optimalLineup`, from Yahoo's roster_positions (bench and IR are dropped by the lineup code). */
export function yahooSlots(settings: unknown): string[] {
  const entries = collect(find(settings, "roster_positions"), "position");
  return entries.flatMap((e) => {
    const pos = String(e.position);
    const slot = pos === "W/R/T" ? "FLEX" : pos === "W/T" ? "REC_FLEX" : pos === "W/R" ? "WRRB_FLEX" : pos === "Q/W/R/T" ? "SUPER_FLEX" : pos;
    return Array.from({ length: Number(e.count ?? 1) }, () => slot);
  });
}
