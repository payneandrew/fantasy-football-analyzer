import type { Player } from "../sleeper/client.js";
import type { YahooPlayer } from "./league.js";

const TEAM_ALIASES: Record<string, string> = { JAC: "JAX", WSH: "WAS" };
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

const team = (t: string | null | undefined) => {
  const up = (t ?? "").toUpperCase();
  return TEAM_ALIASES[up] ?? up;
};

export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’-]/g, "")
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join(" ");
}

/** Match Yahoo players to Sleeper ids by name and team (Sleeper's own Yahoo ids are missing for most players). */
export function buildMatcher(players: Record<string, Player>) {
  const byName = new Map<string, Player[]>();
  for (const p of Object.values(players)) {
    if (!p.position || ["DEF"].includes(p.position)) continue;
    const key = normalizeName(p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`);
    if (key) byName.set(key, [...(byName.get(key) ?? []), p]);
  }
  return (yp: YahooPlayer): string | null => {
    // Defenses are keyed by team abbreviation in Sleeper's data.
    if (yp.position === "DEF") return players[team(yp.team)] ? team(yp.team) : null;
    const hits = byName.get(normalizeName(yp.name)) ?? [];
    if (hits.length === 0) return null;
    if (hits.length === 1) return hits[0].player_id;
    const sameTeam = hits.filter((h) => team(h.team) === team(yp.team));
    const active = (sameTeam.length ? sameTeam : hits).filter((h) => h.status === "Active");
    return (active[0] ?? sameTeam[0] ?? hits[0]).player_id;
  };
}
