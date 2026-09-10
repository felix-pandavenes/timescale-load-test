import { readFileSync } from "node:fs";
import type { QueryDef } from "../domain.js";

export type { QueryDef } from "../domain.js";

/** Reads and validates the query pool at path — a JSON array of QueryDef. */
export function loadQueryPool(path: string): QueryDef[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${path}: expected a non-empty JSON array of queries`);
  }

  const seen = new Set<string>();
  const queries: QueryDef[] = parsed.map((entry, i) => {
    const q = entry as Partial<QueryDef>;
    if (!q.name) {
      throw new Error(`${path}: query at index ${i} is missing required "name" field`);
    }
    if (!q.sql) {
      throw new Error(`${path}: query "${q.name}" is missing required "sql" field`);
    }
    if (seen.has(q.name)) {
      throw new Error(`${path}: duplicate query name "${q.name}"`);
    }
    seen.add(q.name);
    return { name: q.name, sql: q.sql, disabled: q.disabled ?? false, params: q.params ?? [] };
  });

  return queries.filter((q) => !q.disabled);
}
