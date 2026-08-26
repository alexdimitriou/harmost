import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { check } from "./check.js";
import { loadLedger } from "./ledger.js";
import { writeLock, LOCK_FILE, readLock } from "./lock.js";

/** A repo with one ratified decision, and its ratification recorded. */
function ratified(): { cwd: string; path: string } {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-lock-"));
  init({ cwd });
  const { path } = newAdr("Windows come from one factory", {
    class: "3",
    symbols: "createWindow",
    cwd,
  });
  writeFileSync(path, readFileSync(path, "utf8").replace(/^status:.*$/m, "status: accepted"), "utf8");
  // Something must hold it, or the ADR fails for an unrelated reason.
  writeFileSync(
    join(cwd, "rule.test.ts"),
    "test('windows come from one factory', () => {})\n",
    "utf8",
  );
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "enforced-by: []",
      `enforced-by:\n  - file: "rule.test.ts"\n    type: test\n    name: "windows come from one factory"`,
    ),
    "utf8",
  );
  writeLock(cwd, loadLedger(join(cwd, "adr")).records);
  return { cwd, path };
}

const failures = (cwd: string): string =>
  check(cwd)
    .results.flatMap((r) => r.failures)
    .join(" | ");

const edit = (path: string, from: RegExp | string, to: string): void =>
  writeFileSync(path, readFileSync(path, "utf8").replace(from as RegExp, to), "utf8");

test("L0 — a ledger matching its lock passes", () => {
  const { cwd } = ratified();
  assert.equal(check(cwd).ok, true);
  assert.equal(check(cwd).lockState, "guarded");
});

test("L1 — un-ratifying is refused, and it is the one that hides", () => {
  // Moving back to `proposed` makes the gate ignore the rule AND leaves the
  // class-4 count unchanged, so the number reported upward as risk stays flat
  // while the rule stops being held. It has to be the loudest failure here.
  const { cwd, path } = ratified();
  edit(path, /^status: accepted$/m, "status: proposed");

  assert.equal(check(cwd).ok, false);
  assert.match(failures(cwd), /was ratified and is now `proposed`/);
});

test("L2 — demoting the class is refused", () => {
  const { cwd, path } = ratified();
  edit(path, /^enforcement-class: 3$/m, "enforcement-class: 4");

  assert.equal(check(cwd).ok, false);
  assert.match(failures(cwd), /now claims class 4/);
});

test("L3 — strengthening the class is not a weakening", () => {
  const { cwd, path } = ratified();
  edit(path, /^enforcement-class: 3$/m, "enforcement-class: 2");

  assert.match(failures(cwd), /^$|(?!.*claims class)/);
  assert.doesNotMatch(failures(cwd), /claims class/);
});

test("L4 — rewording a ratified Decision is refused", () => {
  const { cwd, path } = ratified();
  edit(path, "The rule, stated so that a violation is unambiguous.", "Windows should usually come from the factory.");

  assert.equal(check(cwd).ok, false);
  assert.match(failures(cwd), /Decision changed after ratification/);
});

test("L5 — deleting a ratified decision is refused", () => {
  const { cwd, path } = ratified();
  rmSync(path);

  assert.equal(check(cwd).ok, false);
  assert.match(failures(cwd), /no longer in the ledger/);
});

test("L6 — superseding is allowed, but only when something claims it", () => {
  const { cwd, path } = ratified();
  edit(path, /^status: accepted$/m, "status: superseded");

  // Nothing replaces it yet: superseded-by-nobody is deletion with a label.
  assert.equal(check(cwd).ok, false);
  assert.match(failures(cwd), /no decision claims it/);

  const { path: replacement } = newAdr("Windows come from one factory, and declare a surface", {
    class: "3",
    symbols: "createWindow",
    cwd,
  });
  edit(replacement, /^supersedes: null$/m, "supersedes: ADR-001");
  assert.doesNotMatch(failures(cwd), /no decision claims it/);
});

test("L7 — a new decision needs no entry in the lock", () => {
  const { cwd } = ratified();
  newAdr("Something else entirely", { class: "3", symbols: "elsewhere", cwd });
  assert.equal(check(cwd).ok, true);
});

test("L8 — re-ratifying accepts the change deliberately", () => {
  // The escape hatch, and it is the point: weakening is not impossible, it is
  // an act. Owning the lock's path is what makes that act need agreement.
  const { cwd, path } = ratified();
  edit(path, /^enforcement-class: 3$/m, "enforcement-class: 4");
  // Class 4 costs a written justification whatever the lock says — the two
  // rules stack, so a demotion has to be argued as well as re-ratified.
  edit(path, /^justification: null$/m, "justification: nothing but review can hold this");
  assert.equal(check(cwd).ok, false);

  writeLock(cwd, loadLedger(join(cwd, "adr")).records);
  assert.equal(check(cwd).ok, true);
  assert.equal(readLock(cwd)?.adrs["ADR-001"]?.class, 4);
});

test("L9 — without a lock the ledger is unguarded, and the report says so", () => {
  const { cwd } = ratified();
  rmSync(join(cwd, LOCK_FILE));

  const report = check(cwd);
  assert.equal(report.lockState, "absent");
  assert.equal(report.ok, true, "an unguarded ledger is not a broken one");
});

test("L10 — a lock that does not parse is a failure, never an absent guard", () => {
  const { cwd } = ratified();
  writeFileSync(join(cwd, LOCK_FILE), "adrs: [this is: not: valid\n", "utf8");

  const report = check(cwd);
  assert.equal(report.lockState, "unreadable");
  assert.equal(report.ok, false);
});

test("L11 — init --ci github writes the ownership that makes the lock a control", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-owners-"));
  init({ cwd, ci: "github" });
  const owners = join(cwd, ".github", "CODEOWNERS");

  assert.ok(existsSync(owners));
  const text = readFileSync(owners, "utf8");
  for (const path of ["adr/", LOCK_FILE, "harmost.yaml"]) {
    assert.ok(text.includes(path), `${path} must be owned`);
  }
});
