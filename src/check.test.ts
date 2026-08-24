import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { check } from "./check.js";

function repo(config?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-check-"));
  init({ cwd });
  if (config !== undefined) appendFileSync(join(cwd, "harmost.yaml"), config, "utf8");
  return cwd;
}

/** Rewrite an ADR's frontmatter fields in place. */
function edit(path: string, edits: Record<string, string>): void {
  let s = readFileSync(path, "utf8");
  for (const [key, value] of Object.entries(edits)) {
    s = s.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`);
  }
  writeFileSync(path, s, "utf8");
}

function withArtifacts(path: string, block: string): void {
  writeFileSync(path, readFileSync(path, "utf8").replace("enforced-by: []", block), "utf8");
}

const test2 = (cwd: string) =>
  newAdr("Deactivated users must never authenticate", {
    class: "2",
    symbols: "create_session,active",
    cwd,
  });

test("proposed ADRs need no enforcement — spec §9 criterion 3", () => {
  const cwd = repo();
  test2(cwd);
  const report = check(cwd);
  assert.equal(report.ok, true);
  assert.equal(report.results[0]?.verdict, "pass");
  assert.equal(report.summary.accepted, 0);
});

test("accepted with a missing artifact fails and names it — criterion 4", () => {
  const cwd = repo();
  const { path } = test2(cwd);
  edit(path, { status: "accepted" });
  withArtifacts(path, "enforced-by:\n  - type: test\n    file: tests/auth/matrix.py\n    name: test_matrix");
  const report = check(cwd);
  assert.equal(report.ok, false);
  assert.match(report.results[0]!.failures.join(" "), /tests\/auth\/matrix\.py does not exist/);
});

test("accepted passes once the named test exists — criterion 5", () => {
  const cwd = repo();
  const { path } = test2(cwd);
  edit(path, { status: "accepted" });
  withArtifacts(path, "enforced-by:\n  - type: test\n    file: tests/matrix.py\n    name: test_matrix");
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests/matrix.py"), "def test_matrix():\n    assert True\n", "utf8");
  const report = check(cwd);
  assert.equal(report.ok, true);
  assert.equal(report.summary.enforced, 1);
  assert.equal(report.summary.class4, 0);
});

test("a file that exists but does not name the test still fails", () => {
  const cwd = repo();
  const { path } = test2(cwd);
  edit(path, { status: "accepted" });
  withArtifacts(path, "enforced-by:\n  - type: test\n    file: tests/matrix.py\n    name: test_matrix");
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests/matrix.py"), "def test_something_else():\n    pass\n", "utf8");
  assert.equal(check(cwd).ok, false);
});

test("matching is whole-word — a longer name does not satisfy a shorter claim", () => {
  const cwd = repo();
  const { path } = test2(cwd);
  edit(path, { status: "accepted" });
  withArtifacts(path, "enforced-by:\n  - type: test\n    file: tests/m.py\n    name: test_login");
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests/m.py"), "def test_login_matrix_extra():\n    pass\n", "utf8");
  assert.equal(check(cwd).ok, false, "test_login_matrix_extra must not satisfy test_login");
});

test("enforced counts resolution, not declaration", () => {
  const cwd = repo();
  const { path } = test2(cwd);
  edit(path, { status: "accepted" });
  withArtifacts(path, "enforced-by:\n  - type: test\n    file: nope.py\n    name: test_x");
  // An artifact was declared, so a naive count would say 1. It resolved to nothing.
  assert.equal(check(cwd).summary.enforced, 0);
});

test("accepted with empty enforced-by fails", () => {
  const cwd = repo();
  const { path } = test2(cwd);
  edit(path, { status: "accepted" });
  assert.match(check(cwd).results[0]!.failures.join(" "), /nothing holds this invariant/);
});

test("class 4 needs a justification, and shows up in the headline count — criterion 7", () => {
  const cwd = repo();
  const { path } = newAdr("Impersonation must be audited", { class: "4", symbols: "impersonate", cwd });
  edit(path, { status: "accepted" });
  assert.equal(check(cwd).ok, false);

  edit(path, { justification: '"No choke point yet; sampled review until ADR-004 lands."' });
  const after = check(cwd);
  assert.equal(after.ok, true);
  assert.equal(after.summary.class4, 1);
});

test("lint artifacts are existence-only for the tracer", () => {
  const cwd = repo();
  const { path } = newAdr("No direct session construction", { class: "3", symbols: "create_session", cwd });
  edit(path, { status: "accepted" });
  withArtifacts(path, "enforced-by:\n  - type: lint\n    file: ci/no-direct-session.sh");
  assert.equal(check(cwd).ok, false);
  mkdirSync(join(cwd, "ci"), { recursive: true });
  writeFileSync(join(cwd, "ci/no-direct-session.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  assert.equal(check(cwd).ok, true);
});

test("duplicate ids fail", () => {
  const cwd = repo();
  test2(cwd);
  const second = newAdr("Another rule", { class: "2", symbols: "x", cwd });
  edit(second.path, { id: "ADR-001" });
  assert.match(check(cwd).results.flatMap((r) => r.failures).join(" "), /id also used by/);
});

test("an id that disagrees with its filename fails", () => {
  const cwd = repo();
  const { path } = test2(cwd);
  edit(path, { id: "ADR-042" });
  assert.match(check(cwd).results[0]!.failures.join(" "), /does not match filename/);
});

test("supersession must be symmetric", () => {
  const cwd = repo();
  const first = test2(cwd);
  const second = newAdr("Replacement rule", { class: "2", symbols: "x", cwd });

  edit(second.path, { supersedes: "ADR-999" });
  assert.match(check(cwd).results.flatMap((r) => r.failures).join(" "), /not in the ledger/);

  edit(second.path, { supersedes: "ADR-001" });
  assert.match(
    check(cwd).results.flatMap((r) => r.failures).join(" "),
    /but ADR-001 is `proposed`, not `superseded`/,
  );

  edit(first.path, { status: "superseded" });
  assert.equal(check(cwd).ok, true);
});

test("an ADR the hook can never deliver fails", () => {
  const cwd = repo();
  const { path } = test2(cwd);
  withArtifacts(path, "enforced-by: []");
  writeFileSync(path, readFileSync(path, "utf8").replace(/symbols:\n(  - .*\n)+/, "symbols: []\n"), "utf8");
  assert.match(check(cwd).results[0]!.failures.join(" "), /could never surface this rule/);
});

test("unreadable and misnamed ledger files are reported, not skipped", () => {
  const cwd = repo();
  writeFileSync(join(cwd, "adr", "ADR-001-broken.md"), "no frontmatter here\n", "utf8");
  writeFileSync(join(cwd, "adr", "ADR-2-bad-name.md"), "---\nid: ADR-2\n---\n", "utf8");
  const report = check(cwd);
  assert.equal(report.ok, false);
  const messages = report.results.flatMap((r) => r.failures).join(" ");
  assert.match(messages, /no YAML frontmatter block/);
  assert.match(messages, /filename must be ADR-<NNN>-<kebab-slug>\.md/);
});

test("TEMPLATE.md is not an ADR", () => {
  const cwd = repo();
  assert.equal(check(cwd).summary.total, 0);
  assert.equal(check(cwd).ok, true);
});

test("Q5 — a per-repo enforced-by map verifies here and reports elsewhere", () => {
  const cwd = repo("repo: centaur-tech\n");
  const { path } = test2(cwd);
  edit(path, { status: "accepted" });
  withArtifacts(
    path,
    [
      "enforced-by:",
      "  centaur-tech:",
      "    - type: test",
      "      file: tests/matrix.py",
      "      name: test_matrix",
      "  mobile:",
      "    - type: test",
      "      file: src/auth/login.test.ts",
      "      name: rejects_deactivated",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests/matrix.py"), "def test_matrix():\n    pass\n", "utf8");

  const report = check(cwd);
  assert.equal(report.results[0]?.verdict, "unverified");
  assert.deepEqual(report.results[0]?.unverifiedRepos, ["mobile"]);
  // Visible, but not a failure: this gate cannot speak for another repo.
  assert.equal(report.ok, true);
  assert.equal(report.summary.unverified, 1);
});

test("Q5 — a map that declares nothing for this repo fails", () => {
  const cwd = repo("repo: centaur-tech\n");
  const { path } = test2(cwd);
  edit(path, { status: "accepted" });
  withArtifacts(
    path,
    ["enforced-by:", "  mobile:", "    - type: test", "      file: x.ts", "      name: y"].join("\n"),
  );
  assert.match(check(cwd).results[0]!.failures.join(" "), /declares no enforcement for this repo/);
});
