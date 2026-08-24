import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, appendFileSync, readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { check } from "./check.js";
import { hookResponse } from "./hook.js";
import { nextId, endpointNeedles } from "./adr.js";
import { readConfig } from "./config-read.js";
import { mergeHookRegistration } from "./claude-settings.js";

/**
 * One test per confirmed finding from the deep review (2026-08-24, round 2).
 * The ratchet: every defect that reached a reviewer merges with the test that
 * would have caught it.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
const run = (cwd: string, args: string[], input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: "utf8" });
const sandbox = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-r2-"));
  init({ cwd });
  return cwd;
};
const accept = (path: string, artifacts?: string) => {
  let s = readFileSync(path, "utf8").replace("status: proposed", "status: accepted");
  if (artifacts !== undefined) s = s.replace("enforced-by: []", artifacts);
  writeFileSync(path, s, "utf8");
};
const goodTest = (cwd: string) => {
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, "tests/a.test.js"), "function test_it() {}\n", "utf8");
  return "enforced-by:\n  - type: test\n    file: tests/a.test.js\n    name: test_it";
};

test("R1 — a missing adr_dir is a config error, not a green gate", () => {
  const cwd = sandbox();
  const { path } = newAdr("A rule", { class: "2", symbols: "s", cwd });
  accept(path, goodTest(cwd));
  assert.equal(run(cwd, ["check"]).status, 0);

  writeFileSync(join(cwd, "harmost.yaml"),
    readFileSync(join(cwd, "harmost.yaml"), "utf8").replace("adr_dir: adr", "adr_dir: docs/adr"), "utf8");
  const typo = run(cwd, ["check"]);
  assert.equal(typo.status, 2, "one typo must not silently disable the whole gate");
  assert.match(typo.stderr, /missing, not empty/);
});

test("R2 — a symlink out of the repo cannot satisfy a test artifact", () => {
  const cwd = sandbox();
  mkdirSync(join(cwd, "tests"), { recursive: true });
  symlinkSync("/etc/passwd", join(cwd, "tests/leak.test.js"));
  const { path } = newAdr("Leaky", { class: "2", symbols: "s", cwd });
  accept(path, "enforced-by:\n  - type: test\n    file: tests/leak.test.js\n    name: root");
  const report = check(cwd);
  assert.equal(report.ok, false, "enforcement must be reproducible from a clean clone");
  assert.match(report.results[0]!.failures.join(" "), /resolves outside the repository/);
});

test("R3 — an empty test_globs allowlist permits nothing, it does not permit everything", () => {
  const cwd = sandbox();
  appendFileSync(join(cwd, "harmost.yaml"), "\n", "utf8");
  writeFileSync(join(cwd, "harmost.yaml"),
    readFileSync(join(cwd, "harmost.yaml"), "utf8").replace(/test_globs:\n(  - .*\n)+/, "test_globs: []\n"), "utf8");
  writeFileSync(join(cwd, "src.js"), "function test_it() {}\n", "utf8");
  const { path } = newAdr("Self-enforcing", { class: "2", symbols: "s", cwd });
  accept(path, "enforced-by:\n  - type: test\n    file: src.js\n    name: test_it");
  assert.equal(check(cwd).ok, false, "production source must not become its own test");
});

test("R4 — an uppercase .MD ADR is not silently skipped", () => {
  const cwd = sandbox();
  writeFileSync(join(cwd, "adr/ADR-001-broken.MD"), "no frontmatter\n", "utf8");
  const report = check(cwd);
  assert.equal(report.ok, false, "a broken ADR must not be invisible because of its extension");
});

test("R5 — enforced-by with both a named repo and '.' verifies both", () => {
  const cwd = sandbox();
  appendFileSync(join(cwd, "harmost.yaml"), "repo: myrepo\n", "utf8");
  const { path } = newAdr("Two buckets", { class: "2", symbols: "s", cwd });
  goodTest(cwd);
  accept(path, [
    "enforced-by:",
    "  myrepo:",
    "    - type: test",
    "      file: tests/a.test.js",
    "      name: test_it",
    "  \".\":",
    "    - type: test",
    "      file: tests/MISSING.test.js",
    "      name: test_it",
  ].join("\n"));
  const report = check(cwd);
  assert.equal(report.ok, false, "the '.' bucket must be verified, not dropped");
  assert.match(report.results[0]!.failures.join(" "), /MISSING/);
});

test("R6 — matchers the hook can never deliver do not satisfy the gate", () => {
  for (const [label, block] of [
    ["empty-string symbol", 'symbols:\n  - ""\nendpoints: []'],
    ["mount-only endpoint", 'symbols: []\nendpoints:\n  - "/api/v1"'],
  ] as [string, string][]) {
    const cwd = sandbox();
    const { path } = newAdr("Undeliverable", { class: "2", symbols: "placeholder", cwd });
    let s = readFileSync(path, "utf8").replace(/symbols:\n(  - .*\n)+endpoints:.*\n/, `${block}\n`);
    writeFileSync(path, s.replace("status: proposed", "status: accepted"), "utf8");
    assert.equal(check(cwd).ok, false, `${label} must fail the deliverability rule`);
  }
});

test("R7 — a '..' artifact path cannot satisfy the gate", () => {
  const cwd = sandbox();
  const { path } = newAdr("Escaping", { class: "3", symbols: "s", cwd });
  accept(path, "enforced-by:\n  - type: lint\n    file: ../../../../../../etc/hostname");
  assert.equal(check(cwd).ok, false, "a verdict must not depend on the runner's filesystem");
});

test("R8 — settings.json shapes we do not understand are refused, never rewritten", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-mangle-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const original = '{"hooks": {"PreToolUse": "guard.sh"}}';
  writeFileSync(join(cwd, ".claude/settings.json"), original, "utf8");
  const result = run(cwd, ["init", "--claude"]);
  assert.equal(readFileSync(join(cwd, ".claude/settings.json"), "utf8"), original,
    "a working hook registration must never be spread into characters");
  assert.match(result.stdout, /REFUSED/);
});

test("R9 — a wrong-typed settings.json does not abort the rest of init", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-abort-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude/settings.json"), '{"hooks": {"PreToolUse": {}}}', "utf8");
  const result = run(cwd, ["init", "--claude", "--ci", "github"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(cwd, ".github/workflows/harmost.yml")), "--ci was requested and must happen");
  assert.ok(existsSync(join(cwd, "harmost.yaml")));
});

test("R10 — an unparseable settings.json is reported loudly, not as 'exists'", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-silent-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude/settings.json"), "{not json", "utf8");
  const result = run(cwd, ["init", "--claude"]);
  assert.match(result.stdout, /REFUSED/);
  assert.match(result.stdout, /hook NOT registered/,
    "silence here leaves the user believing governance is installed when it is inert");
});

test("R11 — adr existing as a plain file is reported, not a raw EEXIST abort", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-eexist-"));
  writeFileSync(join(cwd, "adr"), "not a directory\n", "utf8");
  const result = run(cwd, ["init"]);
  assert.match(result.stdout, /REFUSED/);
  assert.ok(existsSync(join(cwd, "harmost.yaml")), "partial writes must still be reported");
  assert.doesNotMatch(result.stderr, /EEXIST/, "a raw errno is not a report");
});

test("R12 — the registered matcher follows hook.tools in the config", () => {
  const cwd = sandbox();
  writeFileSync(join(cwd, "harmost.yaml"),
    readFileSync(join(cwd, "harmost.yaml"), "utf8").replace("tools: [Edit, Write, MultiEdit]", "tools: [Edit, NotebookEdit]"), "utf8");
  init({ claude: true, cwd });
  const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf8"));
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Edit|NotebookEdit",
    "a hard-coded matcher leaves configured tools unrouted");
});

test("R13 — a large ledger still delivers rather than switching itself off", () => {
  const cwd = sandbox();
  for (let i = 0; i < 400; i += 1) {
    accept(newAdr(`Rule ${i}`, { class: "4", symbols: `sym_${i}_alpha_beta_gamma`, cwd }).path);
  }
  const out = hookResponse({ tool_name: "Edit", tool_input: { new_string: "sym_57_alpha_beta_gamma()" } }, cwd);
  assert.notEqual(out, null, "the hook must not go silent precisely where the ledger is largest");
  assert.match(JSON.parse(out!).hookSpecificOutput.additionalContext, /ADR-058/);
});

test("R14 — a multi-megabyte edit stays inside the host timeout", () => {
  const cwd = sandbox();
  for (let i = 0; i < 150; i += 1) {
    accept(newAdr(`Rule ${i}`, { class: "4", symbols: `s_${i}_a,s_${i}_b,s_${i}_c`, cwd }).path);
  }
  const started = Date.now();
  hookResponse({ tool_name: "Edit", tool_input: { new_string: "x".repeat(3_000_000) } }, cwd);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `took ${elapsed}ms — the host kills at 5s and the edit stalls until then`);
});

test("R15 — whole-word matching is unicode-aware", () => {
  const cwd = sandbox();
  accept(newAdr("Accented", { class: "4", symbols: "café", cwd }).path);
  assert.equal(hookResponse({ tool_name: "Edit", tool_input: { new_string: "const écafé = 1;" } }, cwd), null,
    "écafé must not match café");
  assert.notEqual(hookResponse({ tool_name: "Edit", tool_input: { new_string: "const café = 1;" } }, cwd), null);
});

test("R16 — an endpoint with a query string still reaches its resource", () => {
  assert.deepEqual(endpointNeedles("/Assets?filter=x"), ["Assets"]);
  assert.deepEqual(endpointNeedles("/api/v1/Assets#frag"), ["Assets"]);
  const cwd = sandbox();
  accept(newAdr("Query", { class: "4", symbols: "zzz_never", endpoints: "/Assets?filter=x", cwd }).path);
  assert.notEqual(hookResponse({ tool_name: "Edit", tool_input: { new_string: "apiClient.get('/Assets')" } }, cwd), null);
});

test("R17 — new does not promise the gate ignores a file the gate rejects", () => {
  const cwd = sandbox();
  const result = run(cwd, ["new", "A rule with no matchers"]);
  assert.doesNotMatch(result.stdout, /The gate ignores it until it is accepted/);
  assert.match(result.stdout, /will FAIL until it has symbols or endpoints/);
  assert.equal(run(cwd, ["check"]).status, 1, "and the gate really does fail");
});

test("R18 — an id beyond safe integer range is refused, not emitted as 1e+21", () => {
  const cwd = sandbox();
  writeFileSync(join(cwd, "adr/ADR-999999999999999999999-x.md"), "---\nid: x\n---\n", "utf8");
  assert.throws(() => nextId(join(cwd, "adr")), /too large to allocate from/);
  const result = run(cwd, ["new", "past double precision", "--symbols", "foo"]);
  assert.equal(result.status, 2);
  assert.ok(
    !readdirSync(join(cwd, "adr")).some((f) => f.includes("e+")),
    "no ADR-1e+21-*.md may be written",
  );
});

test("R19 — adr_dir must name a subdirectory inside the repo", () => {
  for (const bad of ["../outside", "", "/", "/etc", "."]) {
    const cwd = mkdtempSync(join(tmpdir(), "harmost-dir-"));
    writeFileSync(join(cwd, "harmost.yaml"), `version: 1\nadr_dir: "${bad}"\n`, "utf8");
    assert.throws(() => readConfig(cwd), /adr_dir/, `adr_dir "${bad}" must be rejected`);
  }
  const ok = mkdtempSync(join(tmpdir(), "harmost-dir-ok-"));
  writeFileSync(join(ok, "harmost.yaml"), "version: 1\nadr_dir: docs/adr\n", "utf8");
  assert.equal(readConfig(ok).adrDir, "docs/adr");
});

test("R20/R21 — the package declares the Node it actually needs and builds on pack", () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"));
  assert.match(pkg.engines.node, /22/, "path.matchesGlob does not exist on Node 20");
  assert.equal(pkg.scripts.prepack, "npm run build", "npm pack from a clean clone must not ship a distless tarball");
});

test("R22 — the JSON contract and enforced-by shape are documented", () => {
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../README.md"), "utf8");
  assert.match(readme, /check --json/);
  assert.match(readme, /unverified_repos/, "the contract's field names must be written down");
  assert.match(readme, /type: test/, "the enforced-by shape must be documented");
});

test("R8b — merge refuses without throwing, for every unrecognised shape", () => {
  for (const input of [
    { hooks: "echo" },
    { hooks: { PreToolUse: {} } },
    { hooks: { PreToolUse: ["str"] } },
    { hooks: { PreToolUse: [{ matcher: "Edit", hooks: "x" }] } },
  ]) {
    const outcome = mergeHookRegistration(input as never);
    assert.equal(outcome.status, "refused");
  }
});

test("Q7 — an artifact that merely exists is `declared`, never `enforced`", () => {
  const cwd = sandbox();
  const { path } = newAdr("Named but unrun", { class: "2", symbols: "s", cwd });
  accept(path, goodTest(cwd));
  const report = check(cwd);

  assert.equal(report.ok, true, "resolution succeeded, so the gate still passes");
  assert.equal(report.summary.enforced, 0, "nothing runs the test, so nothing is enforced");
  assert.equal(report.summary.class4, 1, "and the headline metric counts it as exposure");
  assert.equal(report.results[0]?.unenforced, true);
  assert.match(report.results[0]!.declared.join(" "), /does not run it/);
});

test("Q7 — a lint artifact is declared, not enforced", () => {
  const cwd = sandbox();
  const { path } = newAdr("Lint only", { class: "3", symbols: "s", cwd });
  accept(path, "enforced-by:\n  - type: lint\n    file: harmost.yaml");
  const report = check(cwd);
  assert.equal(report.summary.class4, 1, "a file that exists holds nothing");
  assert.match(report.results[0]!.declared.join(" "), /nothing runs it/);
});

test("Q7 — the class-4 total counts reality, not the frontmatter's claim", () => {
  const cwd = sandbox();
  // One honest class 4, one class 2 that nothing enforces.
  const four = newAdr("Honest exposure", { class: "4", symbols: "a", cwd });
  accept(four.path);
  writeFileSync(four.path,
    readFileSync(four.path, "utf8").replace("justification: null", 'justification: "no choke point yet"'), "utf8");
  const two = newAdr("Claims class 2", { class: "2", symbols: "b", cwd });
  accept(two.path, goodTest(cwd));

  assert.equal(check(cwd).summary.class4, 2, "both are uninsured, whatever they declare");
});

test("Q7 — the JSON contract carries the new states additively", () => {
  const cwd = sandbox();
  const { path } = newAdr("Contract", { class: "2", symbols: "s", cwd });
  accept(path, goodTest(cwd));
  const parsed = JSON.parse(run(cwd, ["check", "--json"]).stdout);
  assert.equal(parsed.version, 1, "additive change, same major");
  assert.equal(parsed.adrs[0].unenforced, true);
  assert.ok(Array.isArray(parsed.adrs[0].declared));
  assert.equal(parsed.summary.class4, 1);
});

/**
 * Round 3 (2026-08-24) — found while preparing the first company pilot.
 *
 * The hook bounded its work with a wall-clock deadline armed *before* the
 * ledger was read, so a large ledger spent the budget on I/O and delivered
 * nothing. R13 caught the total silence; these two catch the shape of the bug
 * rather than one symptom of it.
 */
test("R23 — delivery does not degrade with position in the ledger", () => {
  const cwd = sandbox();
  const LEDGER = 500;
  let last = "";
  for (let i = 0; i < LEDGER; i += 1) {
    last = `sym_${i}_alpha_beta_gamma`;
    accept(newAdr(`Rule ${i}`, { class: "4", symbols: last, cwd }).path);
  }
  // The LAST record, not an early one: a budget that runs out mid-scan silently
  // truncates the tail of the ledger, so the ADRs least likely to be delivered
  // are the ones most recently ratified.
  const out = hookResponse({ tool_name: "Edit", tool_input: { new_string: `${last}()` } }, cwd);
  assert.notEqual(out, null, "the newest ADR in a large ledger must still be delivered");
  assert.match(
    JSON.parse(out!).hookSpecificOutput.additionalContext,
    new RegExp(`ADR-${String(LEDGER).padStart(3, "0")}`),
  );
});

test("R24 — no wall clock in the delivery path", () => {
  const source = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "hook.ts");
  assert.ok(existsSync(source), `expected the hook source at ${source}`);
  // Structural, not stylistic. Any clock read makes which ADRs an agent is shown
  // a function of machine load, so the same edit delivers different rules on
  // different runs and a failure to deliver is unreproducible from a clean clone.
  assert.doesNotMatch(
    readFileSync(source, "utf8"),
    /Date\.now\(\)|performance\.now\(\)|new Date\(/,
    "delivery must be a pure function of (edited text, ledger)",
  );
});
