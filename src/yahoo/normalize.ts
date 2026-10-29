/**
 * Yahoo's JSON is built for XML: lists are objects keyed "0","1",... plus "count", and a single entity is
 * an array of one-key objects. `normalize` turns that into plain objects and arrays.
 */
export function normalize(node: unknown): any {
  if (Array.isArray(node)) {
    const out: Record<string, any> = {};
    for (const el of node) {
      const n = normalize(el);
      if (n === null || typeof n !== "object" || Array.isArray(n)) continue;
      for (const [k, v] of Object.entries(n)) {
        // Repeated keys (for example several {position: ...} items) become a list.
        out[k] = k in out ? [...asArray(out[k]), v] : v;
      }
    }
    return out;
  }
  if (node !== null && typeof node === "object") {
    const keys = Object.keys(node);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k) || k === "count")) {
      return keys
        .filter((k) => k !== "count")
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => normalize((node as any)[k]));
    }
    return Object.fromEntries(keys.map((k) => [k, normalize((node as any)[k])]));
  }
  return node;
}

export const asArray = <T>(x: T | T[] | undefined | null): T[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/** First value stored under `key` anywhere inside `node` (depth first). */
export function find(node: any, key: string): any {
  if (node === null || typeof node !== "object") return undefined;
  if (!Array.isArray(node) && key in node) return node[key];
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = find(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Every object that has `key` as an own property; does not descend into a match. */
export function collect(node: any, key: string): any[] {
  if (node === null || typeof node !== "object") return [];
  if (!Array.isArray(node) && key in node) return [node];
  return (Array.isArray(node) ? node : Object.values(node)).flatMap((v) => collect(v, key));
}
