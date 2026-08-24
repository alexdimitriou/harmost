import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { check } from "./check.js";
import { hookResponse, endpointNeedles } from "./hook.js";

/**
 * One test per finding from the 2026-08-24 review. Every defect that reached
 * a reviewer merges with the test that would have caught it — the ratchet,
 * applied to this codebase rather than to somebody else's.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
const run = (cwd: string, args: string[], input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: "utf8" });

const sandbox = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-regress-"));
  init({ cwd });
  return cwd;
};
const accept = (path: string, artifacts?: string) => {
  let s = readFileSync(path, "utf8").replace("status: proposed", "status: accepted");
  if (artifacts !== undefined) s = s.replace("enforced-by: []", artifacts);
  writeFileSync(path, s, "utf8");
};
const LINT_OK = "enforced-by:\n  - type: lint\n    file: harmost.yaml";

test("F1 — a large hook payload is not truncated at the pipe buffer", () => {
  const cwd = sandbox();
  const { path } = newAdr("Big rule", { class: "3", symbols: "create_session", cwd });
  accept(path, LINT_OK);
  appendFileSync(path, `\n<!-- ${"x".repeat(300_000)} -->\n`, "utf8");

  const result = run(cwd, ["hook"], JSON.stringify({ tool_name: "Edit", tool_input: { new_string: "create_session(u)" } }));
  assert.equal(result.status, 0);
  assert.ok(result.stdout.length > 65_536, `only ${result.stdout.length} bytes emitted`);
  assert.doesNotThrow(() => JSON.parse(result.stdout), "the host must receive parseable JSON");
});

test("F2 — check --json is not truncated at the pipe buffer", () => {
  const cwd = sandbox();
  for (let i = 0; i < 400; i += 1) newAdr(`Rule number ${i}`, { class: "2", symbols: `sym_${i}`, cwd });
  const result = run(cwd, ["check", "--json"]);
  assert.ok(result.stdout.length > 65_536, `only ${result.stdout.length} bytes emitted`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.adrs.length, 400, "the public contract must carry every ADR");
});

test("F3 — a degenerate endpoint does not match every edit", () => {
  for (const route of ["/", "/api", "/api/v1", "/{id}"]) {
    assert.deepEqual(endpointNeedles(route), [], `${route} must yield no needles`);
  }
  const cwd = sandbox();
  const { path } = newAdr("Degenerate", { class: "3", symbols: "zzz_never", endpoints: "/", cwd });
  accept(path, LINT_OK);
  assert.equal(
    hookResponse({ tool_name: "Edit", tool_input: { new_string: "grain silo temperature docs" } }, cwd),
    null,
  );
});

test("F4 — init honours an adr_dir that is already configured", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-adrdir-"));
  writeFileSync(join(cwd, "harmost.yaml"), "version: 1\nadr_dir: decisions\n", "utf8");
  init({ cwd });
  assert.ok(existsSync(join(cwd, "decisions/TEMPLATE.md")), "template must land where new will read it");
  assert.ok(!existsSync(join(cwd, "adr/TEMPLATE.md")));
});

test("F5 — an unparseable settings.json does not abandon the rest of the scaffold", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-badsettings-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude/settings.json"), "", "utf8");
  const result = run(cwd, ["init", "--claude", "--ci", "github"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(cwd, ".github/workflows/harmost.yml")), "--ci was requested and must still happen");
  assert.equal(readFileSync(join(cwd, ".claude/settings.json"), "utf8"), "", "their unreadable file is left alone");
});

test("F6 — the template placeholder does not satisfy the deliverability rule", () => {
  const cwd = sandbox();
  const { path } = newAdr("A rule with no symbols given", { class: "3", cwd });
  accept(path, LINT_OK);
  const report = check(cwd);
  assert.equal(report.ok, false, "an ADR the hook can never surface must not pass");
  assert.match(report.results[0]!.failures.join(" "), /could never surface this rule/);
});

test("F7 — proposed ADRs are not described to the agent as ratified", () => {
  const cwd = sandbox();
  newAdr("A draft rule", { class: "2", symbols: "draft_symbol", cwd });
  const out = hookResponse({ tool_name: "Edit", tool_input: { new_string: "draft_symbol()" } }, cwd);
  const context = JSON.parse(out!).hookSpecificOutput.additionalContext as string;
  assert.match(context, /still proposed/);
  assert.match(context, /\[PROPOSED\]/);
  assert.doesNotMatch(context, /the merge gate enforces/);
});

test("F8 — a lint artifact naming a directory is not enforcement", () => {
  const cwd = sandbox();
  const { path } = newAdr("Directory artifact", { class: "3", symbols: "x", cwd });
  accept(path, "enforced-by:\n  - type: lint\n    file: .");
  const report = check(cwd);
  assert.equal(report.ok, false);
  assert.match(report.results[0]!.failures.join(" "), /is not a file/);
});

test("F9 — endpoints match whichever side carries the mount prefix", () => {
  assert.deepEqual(endpointNeedles("/api/v1/Assets/findOne"), ["Assets", "findOne"]);
  assert.deepEqual(endpointNeedles("/Assets/findOne"), ["Assets", "findOne"]);

  const cwd = sandbox();
  // The swagger-generated list carries full backend paths...
  const { path } = newAdr("Asset reads are tenant scoped", {
    class: "3",
    symbols: "zzz_never",
    endpoints: "/api/v1/Assets/findOne",
    cwd,
  });
  accept(path, LINT_OK);
  // ...while the client writes the bare resource. It must still be delivered.
  const out = hookResponse({ tool_name: "Edit", tool_input: { new_string: "apiClient.get('/Assets/findOne')" } }, cwd);
  assert.notEqual(out, null, "a backend-declared route must reach a client using the short form");
});

test("F10 — a test artifact outside test_globs does not satisfy the gate", () => {
  const cwd = sandbox();
  const { path } = newAdr("Points at production code", { class: "2", symbols: "create_session", cwd });
  writeFileSync(join(cwd, "server.js"), "function test_it() {}\n", "utf8");
  accept(path, "enforced-by:\n  - type: test\n    file: server.js\n    name: test_it");
  const report = check(cwd);
  assert.equal(report.ok, false, "production source must not count as its own test");
  assert.match(report.results[0]!.failures.join(" "), /outside test_globs/);

  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests/auth.test.js"), "function test_it() {}\n", "utf8");
  accept(path.replace("x", "x"), undefined);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("file: server.js", "file: tests/auth.test.js"),
    "utf8",
  );
  assert.equal(check(cwd).ok, true);
});
