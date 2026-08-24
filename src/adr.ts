import { readdirSync, existsSync } from "node:fs";

export const ADR_FILE = /^ADR-(\d{3,})-[a-z0-9-]+\.md$/;

/** ids are allocated densely from 001; gaps are never reused, because an id
 *  that once named a decision must not later name a different one. */
export function nextId(adrDirPath: string): number {
  if (!existsSync(adrDirPath)) return 1;
  const used = readdirSync(adrDirPath)
    .map((f) => ADR_FILE.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number.parseInt(m[1]!, 10));
  if (used.length === 0) return 1;
  const highest = Math.max(...used);
  if (!Number.isSafeInteger(highest) || highest + 1 > Number.MAX_SAFE_INTEGER) {
    // Beyond double precision, String(n) yields "1e+21" and the filename stops
    // matching the tool's own ADR pattern — `new` would write a file `check`
    // then rejects as unreadable.
    throw new Error(
      `the highest ADR id in the ledger (${String(highest)}) is too large to allocate from`,
    );
  }
  return highest + 1;
}

export const formatId = (n: number): string => `ADR-${String(n).padStart(3, "0")}`;

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}

export function parseSymbols(input?: string): string[] {
  return (input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseClass(input?: string): 1 | 2 | 3 | 4 {
  // Absent means unconsidered, and an invariant whose enforcement nobody has
  // thought about is class 4 by definition. Defaulting lower would flatter.
  if (input === undefined) return 4;
  const n = Number.parseInt(input, 10);
  if (![1, 2, 3, 4].includes(n)) {
    throw new Error(`enforcement class must be 1, 2, 3 or 4 — got "${input}"`);
  }
  return n as 1 | 2 | 3 | 4;
}

export interface AdrSeed {
  id: string;
  title: string;
  enforcementClass: 1 | 2 | 3 | 4;
  symbols: string[];
  endpoints?: string[];
  date: string;
}

/** Quote defensively: titles carry colons, and a bare colon breaks YAML. */
const yamlString = (s: string): string => JSON.stringify(s);

export function renderFrontmatter(seed: AdrSeed): string {
  const symbols =
    seed.symbols.length > 0
      ? seed.symbols.map((s) => `  - ${yamlString(s)}`).join("\n")
      : "  - <identifier the hook should match on>";
  return `---
id: ${seed.id}
title: ${yamlString(seed.title)}
date: ${seed.date}
status: proposed
enforcement-class: ${seed.enforcementClass}
invariant: >
  ${seed.title}
applies-to:
  - "src/**"
symbols:
${symbols}
endpoints:${
    (seed.endpoints ?? []).length > 0
      ? `\n${(seed.endpoints ?? []).map((e) => `  - ${yamlString(e)}`).join("\n")}`
      : " []                # optional API routes, matched on resource segments"
  }
enforced-by: []
supersedes: null
justification: null
---`;
}

/** Keep the template's prose guidance, replace its frontmatter. */
export function bodyOfTemplate(template: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(template);
  return match ? template.slice(match[0].length) : template;
}

/** Mount-point noise. Stripped from the ledger's route so a rule reaches a
 *  client whichever side carries the prefix — the swagger-generated list is
 *  full backend paths, while clients often write the bare resource. */
const MOUNT_SEGMENT = /^(api|rest|public|internal|v\d+)$/i;

/** Endpoints are matched on their resource segments: prefixes differ between
 *  clients (`/Assets/findOne` vs `/api/v1/Assets/findOne`) but the resource
 *  does not. Path parameters are skipped — `{id}` names nothing in the code. */
export const endpointNeedles = (endpoint: string): string[] => {
  // A declared route may carry a query string or fragment; the resource is what
  // the client's code contains, so "/Assets?filter=x" must still reach an edit
  // touching "/Assets" rather than requiring the literal query in the source.
  const segments = endpoint
    .split(/[?#]/)[0]!
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.startsWith("{") && !segment.startsWith(":"));
  let start = 0;
  while (start < segments.length && MOUNT_SEGMENT.test(segments[start]!)) start += 1;
  // Keep at least the last segment: a route that is nothing but mount points
  // has no resource to match on, and must not become a wildcard.
  return start >= segments.length ? [] : segments.slice(start);
};
