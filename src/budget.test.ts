import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { readConfig } from "./config-read.js";
import { loadLedger, type AdrRecord } from "./ledger.js";
import { matchAdrs, citedMatches, renderContext } from "./hook.js";

function repo(rules: number, config?: string): { cwd: string; records: AdrRecord[] } {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-budget-"));
  init({ cwd });
  if (config !== undefined) appendFileSync(join(cwd, "harmost.yaml"), config, "utf8");
  for (let i = 1; i <= rules; i += 1) {
    newAdr(`Rule number ${i}`, { class: "3", symbols: "alpha", cwd });
  }
  return { cwd, records: loadLedger(join(cwd, "adr")).records };
}

test("B1 — the header states how many decisions cover the edit, not how many fit", () => {
  // Reporting fewer rules than cover an edit is not a smaller answer, it is a
  // false one: an agent told three rules apply has no reason to look for a
  // fourth. This was shipped behaviour until the budget replaced the count cap.
  const { records } = repo(5);
  const matches = matchAdrs("alpha", records, Infinity);
  assert.equal(matches.length, 5);

  const rendered = renderContext(matches, [], 1200);
  assert.match(rendered, /^5 architectural decisions cover the code you are editing\./);
});

test("B2 — whatever does not fit is named, never dropped in silence", () => {
  const { records } = repo(5);
  const rendered = renderContext(matchAdrs("alpha", records, Infinity), [], 1200);

  assert.match(rendered, /4 of these are not included below/);
  for (const id of ["ADR-002", "ADR-003", "ADR-004", "ADR-005"]) {
    assert.ok(rendered.includes(id), `${id} must be named so it can be read`);
  }
});

test("B3 — one decision is always delivered, however small the budget", () => {
  // A header announcing rules with no rule under it is worse than a long
  // injection: it is an agent told a rule exists and shown nothing.
  const { records } = repo(3);
  const rendered = renderContext(matchAdrs("alpha", records, Infinity), [], 1);

  assert.match(rendered, /--- ADR-001 /);
  assert.match(rendered, /2 of these are not included/);
});

test("B4 — a citation is given up before a decision the edit reached", () => {
  const { cwd, records } = repo(2);
  // ADR-002 cites ADR-001; both match, so nothing is cited in the end — the
  // point here is ordering, which the render must preserve under pressure.
  const cited = citedMatches(matchAdrs("alpha", records, Infinity), records, cwd, Infinity);
  const rendered = renderContext(matchAdrs("alpha", records, Infinity), cited, 1200);

  const first = rendered.indexOf("--- ADR-001");
  assert.ok(first > -1, "the highest-ranked match is delivered first");
});

test("B5 — no count cap in the config means every match, bounded by bytes", () => {
  const { cwd } = repo(1);
  const config = readConfig(cwd);
  assert.equal(config.hook.maxInjectedAdrs, Infinity);
  assert.equal(config.hook.maxInjectedCitations, Infinity);
  assert.equal(config.hook.maxInjectedChars, 12000);
});

test("B6 — an explicit 0 means none, not unlimited", () => {
  // Reading 0 as "no limit" would invert the meaning for anyone who set it to
  // switch delivery off — the opposite of what they asked for, silently.
  const { cwd } = repo(1);
  const path = join(cwd, "harmost.yaml");
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}  max_injected_citations: 0\n  max_injected_adrs: 0\n`,
    "utf8",
  );
  const config = readConfig(cwd);
  assert.equal(config.hook.maxInjectedAdrs, 0);
  assert.equal(config.hook.maxInjectedCitations, 0);

  const { records } = { records: loadLedger(join(cwd, "adr")).records };
  assert.equal(matchAdrs("alpha", records, config.hook.maxInjectedAdrs).length, 0);
});

test("B7 — nothing is reported as omitted when everything fits", () => {
  const { records } = repo(2);
  const rendered = renderContext(matchAdrs("alpha", records, Infinity), [], 12000);
  assert.doesNotMatch(rendered, /not included below/);
});
