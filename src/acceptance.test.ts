import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI spec §9, end to end against the built binary — exit codes, stdin and
 * stdout included. The unit suites cover the same ground through function
 * calls; this one exists because the thing users run is a process, and a
 * wrong exit code is invisible to every test that never spawns one.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}
const run = (cwd: string, args: string[], input?: string): Run => {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const ADR_PATH = "adr/ADR-001-deactivated-users-must-never-authenticate.md";

function fingerprint(cwd: string): string {
  const walk = (dir: string, prefix = ""): string[] =>
    readdirSync(join(cwd, dir), { withFileTypes: true })
      .filter((e) => e.name !== ".git")
      .flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name), `${prefix}${e.name}/`)
          : [`${prefix}${e.name}:${readFileSync(join(cwd, dir, e.name), "utf8")}`],
      );
  return walk(".").sort().join("\n");
};

test("CLI spec §9 — the whole tracer, end to end", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-acceptance-"));

  // 1. init scaffolds cleanly, and re-running changes nothing.
  const first = run(cwd, ["init", "--claude", "--ci", "github"]);
  assert.equal(first.status, 0, first.stderr);
  for (const f of ["harmost.yaml", "adr/TEMPLATE.md", ".claude/settings.json", ".github/workflows/harmost.yml"]) {
    assert.match(first.stdout, new RegExp(`created\\s+${f.replace(/[/.]/g, "\\$&")}`), `missing ${f}`);
  }
  const afterInit = fingerprint(cwd);
  assert.equal(run(cwd, ["init", "--claude", "--ci", "github"]).status, 0);
  assert.equal(fingerprint(cwd), afterInit, "re-running init mutated the repo");

  // 2. new creates ADR-001 as proposed.
  const created = run(cwd, [
    "new",
    "Deactivated users must never authenticate",
    "--class", "2",
    "--symbols", "create_session,active,sso_callback",
  ]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /ADR-001 is `proposed`/);
  assert.match(readFileSync(join(cwd, ADR_PATH), "utf8"), /^status: proposed$/m);

  // 3. check passes — proposed ADRs need no enforcement.
  assert.equal(run(cwd, ["check"]).status, 0);

  // 4. accepted, pointing at a test that does not exist → exit 1, named.
  const adr = join(cwd, ADR_PATH);
  writeFileSync(
    adr,
    readFileSync(adr, "utf8")
      .replace("status: proposed", "status: accepted")
      .replace(
        "enforced-by: []",
        "enforced-by:\n  - type: test\n    file: tests/auth/test_login_matrix.py\n    name: test_entry_points_x_user_states",
      ),
    "utf8",
  );
  const missing = run(cwd, ["check"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /ADR-001/);
  assert.match(missing.stdout, /tests\/auth\/test_login_matrix\.py does not exist/);

  // 5. add the fixture test → exit 0, class-4 count 0.
  mkdirSync(join(cwd, "tests/auth"), { recursive: true });
  writeFileSync(
    join(cwd, "tests/auth/test_login_matrix.py"),
    "def test_entry_points_x_user_states():\n    assert True\n",
    "utf8",
  );
  const green = run(cwd, ["check"]);
  assert.equal(green.status, 0, green.stdout);
  assert.match(green.stdout, /CLASS-4 COUNT: 0/);

  // 6. the hook delivers on a symbol match, and is silent otherwise.
  const hit = run(cwd, ["hook"], JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: "/srv/sso.js", new_string: "return create_session(user);" },
  }));
  assert.equal(hit.status, 0);
  const payload = JSON.parse(hit.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(payload.hookSpecificOutput.additionalContext, /ADR-001/);
  assert.equal(payload.hookSpecificOutput.permissionDecision, undefined, "the hook must never decide permissions");

  const miss = run(cwd, ["hook"], JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: "README.md", new_string: "documentation about grain silos" },
  }));
  assert.equal(miss.status, 0);
  assert.equal(miss.stdout.trim(), "", "the hook must be invisible when it has nothing to say");

  // 7. class 4 needs justification; once given, it shows in the headline count.
  assert.equal(run(cwd, ["new", "Impersonation must be audited", "--class", "4", "--symbols", "impersonate"]).status, 0);
  const b = join(cwd, "adr/ADR-002-impersonation-must-be-audited.md");
  writeFileSync(b, readFileSync(b, "utf8").replace("status: proposed", "status: accepted"), "utf8");

  const unjustified = run(cwd, ["check"]);
  assert.equal(unjustified.status, 1);
  assert.match(unjustified.stdout, /no `justification`/);

  writeFileSync(
    b,
    readFileSync(b, "utf8").replace("justification: null", 'justification: "No choke point yet; ADR-004 will close it."'),
    "utf8",
  );
  const justified = run(cwd, ["check"]);
  assert.equal(justified.status, 0, justified.stdout);
  assert.match(justified.stdout, /CLASS-4 COUNT: 1/);
});

test("the hook never breaks the edit loop, whatever it is handed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-hostile-"));
  // Deliberately NOT initialised: no config, no ledger.
  for (const input of ["", "not json at all", "{", '{"tool_name":"Edit"}', '{"tool_input":{"edits":"wrong type"}}']) {
    const result = run(cwd, ["hook"], input);
    assert.equal(result.status, 0, `exit ${result.status} on input: ${input}`);
    assert.equal(result.stdout.trim(), "", `spoke up on input: ${input}`);
  }

  // And with a ledger whose config is corrupt.
  run(cwd, ["init"]);
  writeFileSync(join(cwd, "harmost.yaml"), "this: [is: not: valid: yaml\n", "utf8");
  const corrupt = run(cwd, ["hook"], JSON.stringify({ tool_name: "Edit", tool_input: { new_string: "x" } }));
  assert.equal(corrupt.status, 0);
  assert.equal(corrupt.stdout.trim(), "");
});

test("check reports a config error as exit 2, distinct from a violation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-exit2-"));
  const result = run(cwd, ["check"]);
  assert.equal(result.status, 2, "an uninitialised repo is a config error, not a passing gate");
  assert.match(result.stderr, /Run `npx harmost init` first/);
});
