import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { CONFIG_FILE, DEFAULT_ADR_DIR } from "./name.js";
import { loadLedger, type AdrRecord } from "./ledger.js";

/**
 * A reference from one decision to another, possibly in another ledger.
 *
 * The tool's own governance rules — how an ADR is amended, what an accepted one
 * must carry — are rules *about* ledgers, so every ledger is their subject. A
 * downstream ADR that can only cite one in prose is a rule delivered by whoever
 * happens to read the file, which is class 4 wearing a link's clothes.
 */
export interface AdrRef {
  raw: string;
  /** Package whose ledger holds it, or null for this one. */
  package: string | null;
  id: string;
}

/**
 * Accepts `ADR-004`, `<package>/ADR-004`, `@acme/rules/ADR-004`.
 *
 * The id is the segment after the final slash, so a scoped package keeps its
 * own. Returns null for anything that cannot be one of those, and the gate
 * turns that into a failure: an unparseable reference must never read as an
 * absent one.
 */
export function parseRef(raw: unknown): AdrRef | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // No whitespace anywhere: a sentence is prose, and reading it as an id would
  // report "this ledger has no see the wiki" instead of "that is not a
  // reference" — a confusing failure for the commonest mistake.
  if (/\s/.test(trimmed)) return null;
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return { raw: trimmed, package: null, id: trimmed };
  const pkg = trimmed.slice(0, slash);
  const id = trimmed.slice(slash + 1);
  if (pkg.length === 0 || id.length === 0) return null;
  return { raw: trimmed, package: pkg, id };
}

/** Stable key for deduplication: two ledgers may both hold an `ADR-004`. */
export const refKey = (ref: AdrRef): string => `${ref.package ?? "."}/${ref.id}`;

const cache = new Map<string, string | null>();

/**
 * Where an installed package keeps its ledger, or null if it has none here.
 *
 * Walks up from the repository the way Node resolves a module, so a workspace
 * that hoists dependencies to its root is found. Upstream ledgers live outside
 * the working tree on purpose: the containment rule binding enforcement
 * artifacts is about a verdict being reproducible, and this is a dependency,
 * pinned by the lockfile like any other.
 */
export function upstreamLedgerDir(root: string, pkg: string): string | null {
  const key = `${resolve(root)} ${pkg}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let dir = resolve(root);
  let found: string | null = null;
  for (;;) {
    const installed = join(dir, "node_modules", pkg);
    if (existsSync(installed)) {
      // Honour the upstream's own `adr_dir`: a ledger it moved is still its
      // ledger, and guessing would report a real rule as a dangling reference.
      let adrDir = DEFAULT_ADR_DIR;
      const config = join(installed, CONFIG_FILE);
      if (existsSync(config)) {
        try {
          const raw = (parse(readFileSync(config, "utf8")) ?? {}) as { adr_dir?: unknown };
          if (typeof raw.adr_dir === "string" && raw.adr_dir.trim().length > 0) {
            adrDir = raw.adr_dir.trim();
          }
        } catch {
          // Unreadable config: the default is a better guess than a failure.
        }
      }
      const ledger = join(installed, adrDir);
      found = existsSync(ledger) ? ledger : null;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cache.set(key, found);
  return found;
}

const ledgers = new Map<string, AdrRecord[]>();

/**
 * An installed package's ledger, read-only, or null when it has none here.
 *
 * Read-only is structural rather than promised: the file lives under
 * `node_modules`, so there is nothing in the working tree to edit and nothing
 * for a pull request to change. The version is whatever the lockfile pins, so
 * a rule added upstream reaches this repository through a deliberate upgrade
 * rather than on its own.
 */
export function upstreamLedger(root: string, pkg: string): AdrRecord[] | null {
  const dir = upstreamLedgerDir(root, pkg);
  if (dir === null) return null;
  const hit = ledgers.get(dir);
  if (hit !== undefined) return hit;
  const { records } = loadLedger(dir);
  ledgers.set(dir, records);
  return records;
}

/** Resolve a reference to the decision it names, or null. */
export function resolveRef(
  ref: AdrRef,
  local: AdrRecord[],
  root: string,
): AdrRecord | null {
  const pool = ref.package === null ? local : upstreamLedger(root, ref.package);
  return pool?.find((record) => record.id === ref.id) ?? null;
}
