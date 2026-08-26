import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { check } from "./check.js";
import { verify } from "./verify.js";

/** A repo `verify` can enumerate: the rules read git, not the directory. */
function repo(config?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-verify-"));
  init({ cwd });
  if (config !== undefined) appendFileSync(join(cwd, "harmost.yaml"), config, "utf8");
  spawnSync("git", ["init", "-q"], { cwd });
  return cwd;
}

/** Write a file and put it in the index — `git ls-files` reads the index. */
function track(cwd: string, rel: string, content: string): void {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  spawnSync("git", ["add", "-f", "--", rel], { cwd });
}

function accepted(cwd: string, enforcedBy: string): string {
  const { path } = newAdr("Widgets are constructed in one place", {
    class: "3",
    symbols: "makeWidget",
    cwd,
  });
  let source = readFileSync(path, "utf8");
  source = source.replace(/^status:.*$/m, "status: accepted");
  source = source.replace("enforced-by: []", enforcedBy);
  writeFileSync(path, source, "utf8");
  return path;
}

const CHOKE = `enforced-by:
  - rule: choke-point
    symbol: "makeWidget"
    in: ["src/**"]
    only-from: ["src/factory.ts"]`;

test("V1 — a symbol confined to its permitted module is enforced", () => {
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  // Note what the fixture does NOT do: import `makeWidget` by name. The symbol
  // is the thing that must not spread, not the API other modules call.
  track(cwd, "src/app.ts", "import { build } from './factory'\nbuild()\n");
  accepted(cwd, CHOKE);

  const report = verify(cwd);
  assert.equal(report.ok, true);
  assert.equal(report.summary.enforced, 1);
  assert.equal(report.summary.violations, 0);
});

test("V2 — a symbol outside the choke point fails, and the files are named", () => {
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  track(cwd, "src/rogue.ts", "const w = makeWidget()\n");
  track(cwd, "src/other.ts", "const w = makeWidget()\n");
  accepted(cwd, CHOKE);

  const report = verify(cwd);
  assert.equal(report.ok, false);
  assert.equal(report.summary.failed, 1);
  // The count is the number the ratchet will lock; the names are what makes it
  // actionable rather than merely alarming.
  assert.equal(report.summary.violations, 2);
  const detail = report.results[0]?.artifacts[0]?.detail ?? "";
  assert.match(detail, /src\/other\.ts/);
  assert.match(detail, /src\/rogue\.ts/);
});

test("V3 — a symbol that appears nowhere fails: vacuous truth is not enforcement", () => {
  // A typo in `symbol` would otherwise report green forever, which is exactly
  // the flattering metric Q7 was raised to remove.
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const somethingElse = 1\n");
  accepted(cwd, CHOKE);

  const report = verify(cwd);
  assert.equal(report.ok, false);
  assert.match(report.results[0]?.artifacts[0]?.detail ?? "", /appears in none/);
});

test("V4 — a rule with no `in` scope is refused, not run over the whole tree", () => {
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  accepted(
    cwd,
    `enforced-by:
  - rule: choke-point
    symbol: "makeWidget"
    only-from: ["src/factory.ts"]`,
  );

  const report = verify(cwd);
  assert.equal(report.ok, false);
  assert.match(report.results[0]?.artifacts[0]?.detail ?? "", /no `in` scope/);
});

test("V5 — a choke point with no permitted site permits nothing", () => {
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  accepted(
    cwd,
    `enforced-by:
  - rule: choke-point
    symbol: "makeWidget"
    in: ["src/**"]`,
  );

  const report = verify(cwd);
  assert.equal(report.ok, false);
  assert.match(report.results[0]?.artifacts[0]?.detail ?? "", /no `only-from`/);
});

test("V6 — a test naming the symbol is not a violation of it", () => {
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  track(cwd, "src/widget.test.ts", "it('builds', () => makeWidget())\n");
  accepted(cwd, CHOKE);

  const report = verify(cwd);
  assert.equal(report.ok, true, "the check that holds a rule must not break it");
  assert.equal(report.summary.violations, 0);
});

test("V7 — an untracked file is not scanned: a verdict must survive a clean clone", () => {
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  // Written but never added: it is not part of what the repository ships.
  writeFileSync(join(cwd, "src", "scratch.ts"), "const w = makeWidget()\n", "utf8");
  accepted(cwd, CHOKE);

  assert.equal(verify(cwd).ok, true);
});

test("V8 — an unknown rule fails rather than passing quietly", () => {
  // A ledger written against a newer version must not read as enforced here.
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  accepted(
    cwd,
    `enforced-by:
  - rule: entry-points
    routes: ["/login"]
    through: assertActive`,
  );

  const report = verify(cwd);
  assert.equal(report.ok, false);
  assert.match(report.results[0]?.artifacts[0]?.detail ?? "", /unknown rule/);
});

test("V9 — an accepted ADR backed only by a test nobody runs is inert, and fails", () => {
  // The inversion: not a rule broken, but a rule nothing ever checked.
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests", "widget.test.ts"), "test('holds', () => {})\n", "utf8");
  accepted(
    cwd,
    `enforced-by:
  - file: "tests/widget.test.ts"
    type: test
    name: "holds"`,
  );

  const report = verify(cwd);
  assert.equal(report.ok, false);
  assert.equal(report.summary.inert, 1);
  assert.equal(report.summary.failed, 0);
});

test("V10 — `check` reports a rule as declared, never as an unknown type", () => {
  // check executes nothing by contract; a ledger that adopts rules must not
  // start failing the gate that is supposed to be measuring its coverage.
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  accepted(cwd, CHOKE);

  const report = check(cwd);
  assert.equal(report.ok, true);
  assert.equal(report.results[0]?.verdict, "pass");
  assert.equal(report.summary.enforced, 0, "check cannot resolve enforcement — that is verify's job");
  assert.match(report.results[0]?.declared[0] ?? "", /choke-point/);
});

test("V11 — verify gates accepted class 1-3 only", () => {
  const cwd = repo();
  track(cwd, "src/factory.ts", "export const makeWidget = () => ({})\n");
  // Proposed: not yet a promise.
  newAdr("A proposal", { class: "3", symbols: "makeWidget", cwd });
  assert.equal(verify(cwd).summary.accepted, 0);
});
