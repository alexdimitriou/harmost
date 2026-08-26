import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { check } from "./check.js";
import { matchAdrs, citedMatches, renderContext, hookResponse } from "./hook.js";
import { loadLedger } from "./ledger.js";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-refs-"));
  init({ cwd });
  return cwd;
}

/** An ADR in this repo's ledger, with `cites` set. */
function adr(cwd: string, title: string, symbols: string, cites: string[]): string {
  const { path } = newAdr(title, { class: "3", symbols, cwd });
  const listed =
    cites.length === 0 ? "cites: []" : `cites:\n${cites.map((c) => `  - "${c}"`).join("\n")}`;
  writeFileSync(path, readFileSync(path, "utf8").replace(/^cites: \[\].*$/m, listed), "utf8");
  return path;
}

/** A package installed under node_modules, shipping a ledger of its own. */
function installPackage(cwd: string, pkg: string, id: string): void {
  const dir = join(cwd, "node_modules", pkg, "adr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-upstream-rule.md`),
    `---
id: ${id}
title: "How a ledger is amended"
date: 2026-01-01
status: accepted
enforcement-class: 3
invariant: >
  A ratified Decision changes only by supersession.
applies-to: []
symbols:
  - "supersedes"
endpoints: []
enforced-by: []
cites: []
supersedes: null
justification: null
---

## Decision

A ratified Decision changes only by supersession, never by edit.
`,
    "utf8",
  );
}

test("C1 — a citation that resolves passes the gate", () => {
  const cwd = repo();
  adr(cwd, "The first rule", "alpha", []);
  adr(cwd, "The second rule", "beta", ["ADR-001"]);
  assert.equal(check(cwd).ok, true);
});

test("C2 — a citation to an ADR that is not there fails", () => {
  // Worse than an absent citation: it reads as authority. This is the whole
  // difference between a reference and a line of prose.
  const cwd = repo();
  adr(cwd, "The only rule", "alpha", ["ADR-404"]);
  const report = check(cwd);
  assert.equal(report.ok, false);
  assert.ok(report.results[0]?.failures.some((f) => f.includes("this ledger has no ADR-404")));
});

test("C3 — something that is not a reference is refused, not ignored", () => {
  const cwd = repo();
  adr(cwd, "The only rule", "alpha", ["see the wiki"]);
  const report = check(cwd);
  assert.equal(report.ok, false);
  assert.ok(report.results[0]?.failures.some((f) => f.includes("not a reference")));
});

test("C4 — citing a package whose ledger is not installed fails", () => {
  const cwd = repo();
  adr(cwd, "The only rule", "alpha", ["absent-pkg/ADR-004"]);
  const report = check(cwd);
  assert.equal(report.ok, false);
  assert.ok(report.results[0]?.failures.some((f) => f.includes("no ledger from")));
});

test("C5 — a citation into an installed package's ledger resolves", () => {
  const cwd = repo();
  installPackage(cwd, "upstream-rules", "ADR-004");
  adr(cwd, "The only rule", "alpha", ["upstream-rules/ADR-004"]);
  assert.equal(check(cwd).ok, true);
});

test("C6 — citing a package that has a ledger but not that ADR fails", () => {
  const cwd = repo();
  installPackage(cwd, "upstream-rules", "ADR-004");
  adr(cwd, "The only rule", "alpha", ["upstream-rules/ADR-999"]);
  const report = check(cwd);
  assert.equal(report.ok, false);
  assert.ok(report.results[0]?.failures.some((f) => f.includes("has no ADR-999")));
});

test("C7 — the hook delivers what a matched decision cites", () => {
  const cwd = repo();
  installPackage(cwd, "upstream-rules", "ADR-004");
  adr(cwd, "The only rule", "alpha", ["upstream-rules/ADR-004"]);

  const { records } = loadLedger(join(cwd, "adr"));
  const matches = matchAdrs("touching alpha here", records, 3);
  const cited = citedMatches(matches, records, cwd, 2);

  assert.equal(cited.length, 1);
  assert.equal(cited[0]?.record.id, "ADR-004");
  assert.equal(cited[0]?.source, "upstream-rules");
  assert.equal(cited[0]?.citedBy, "ADR-001");

  const rendered = renderContext(matches, cited);
  assert.match(rendered, /cited by ADR-001/);
  assert.match(rendered, /upstream-rules/);
  assert.match(rendered, /never by edit/, "the cited decision's own rule must arrive with it");
});

test("C8 — citations do not spend the matched budget", () => {
  // A cited decision was chosen by another ADR's author; a matched one was
  // chosen by the code being written. Letting the first crowd out the second
  // inverts relevance.
  const cwd = repo();
  adr(cwd, "First", "alpha", []);
  adr(cwd, "Second", "alpha", []);
  adr(cwd, "Third", "alpha", ["ADR-001"]);

  const { records } = loadLedger(join(cwd, "adr"));
  const matches = matchAdrs("alpha", records, 3);
  assert.equal(matches.length, 3, "all three match the edit and all three are delivered");
  const cited = citedMatches(matches, records, cwd, 2);
  assert.equal(cited.length, 0, "ADR-001 is already matched, so it is not repeated");
});

test("C9 — a citation of a citation is not followed", () => {
  const cwd = repo();
  adr(cwd, "Deepest", "gamma", []);
  adr(cwd, "Middle", "beta", ["ADR-001"]);
  adr(cwd, "Surface", "alpha", ["ADR-002"]);

  const { records } = loadLedger(join(cwd, "adr"));
  const matches = matchAdrs("alpha", records, 3);
  const cited = citedMatches(matches, records, cwd, 5);

  assert.deepEqual(
    cited.map((c) => c.record.id),
    ["ADR-002"],
    "depth 1 only — following the graph is how the whole ledger arrives",
  );
});

test("C10 — the citation budget bounds what a heavily-cited decision injects", () => {
  const cwd = repo();
  adr(cwd, "One", "one", []);
  adr(cwd, "Two", "two", []);
  adr(cwd, "Three", "three", []);
  adr(cwd, "Surface", "alpha", ["ADR-001", "ADR-002", "ADR-003"]);

  const { records } = loadLedger(join(cwd, "adr"));
  const matches = matchAdrs("alpha", records, 3);
  assert.equal(citedMatches(matches, records, cwd, 2).length, 2);
});

test("C11 — an unresolvable citation is silent in the hook, and loud in the gate", () => {
  // The hook must never break the edit loop. Its silence is safe only because
  // `check` fails the build on the same reference.
  const cwd = repo();
  adr(cwd, "The only rule", "alpha", ["absent-pkg/ADR-004"]);

  const response = hookResponse({ tool_name: "Edit", tool_input: { new_string: "alpha" } }, cwd);
  assert.ok(response !== null, "the matched decision is still delivered");
  assert.doesNotMatch(response, /absent-pkg/);
  assert.equal(check(cwd).ok, false);
});
