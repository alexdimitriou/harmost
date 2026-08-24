import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";
import { CONFIG_FILE } from "./name.js";
import { WORKFLOW_PATH } from "./ci-github.js";
import { HOOK_COMMAND } from "./claude-settings.js";

const sandbox = () => mkdtempSync(join(tmpdir(), "harmost-test-"));

test("scaffolds config, template, hook and workflow", () => {
  const cwd = sandbox();
  const results = init({ claude: true, ci: "github", cwd });
  assert.equal(results.every((r) => r.outcome === "created"), true);
  assert.ok(existsSync(join(cwd, CONFIG_FILE)));
  assert.ok(existsSync(join(cwd, "adr", "TEMPLATE.md")));
  assert.ok(existsSync(join(cwd, WORKFLOW_PATH)));
  assert.ok(readFileSync(join(cwd, ".claude/settings.json"), "utf8").includes(HOOK_COMMAND));
});

test("re-running changes nothing — CLI spec §9 criterion 1", () => {
  const cwd = sandbox();
  init({ claude: true, ci: "github", cwd });
  const before = [CONFIG_FILE, "adr/TEMPLATE.md", WORKFLOW_PATH, ".claude/settings.json"].map((p) =>
    readFileSync(join(cwd, p), "utf8"),
  );
  const second = init({ claude: true, ci: "github", cwd });
  assert.equal(second.every((r) => r.outcome === "skipped"), true);
  const after = [CONFIG_FILE, "adr/TEMPLATE.md", WORKFLOW_PATH, ".claude/settings.json"].map((p) =>
    readFileSync(join(cwd, p), "utf8"),
  );
  assert.deepEqual(after, before);
});

test("never overwrites a hand-edited config", () => {
  const cwd = sandbox();
  writeFileSync(join(cwd, CONFIG_FILE), "version: 1\nadr_dir: decisions\n", "utf8");
  const results = init({ cwd });
  assert.equal(results[0]?.outcome, "skipped");
  assert.equal(readFileSync(join(cwd, CONFIG_FILE), "utf8"), "version: 1\nadr_dir: decisions\n");
});

test("merges into an existing settings.json without losing its contents", () => {
  const cwd = sandbox();
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude/settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }, null, 2),
    "utf8",
  );
  init({ claude: true, cwd });
  const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(git status)"] });
  assert.ok(JSON.stringify(settings.hooks).includes(HOOK_COMMAND));
});

test("rejects an unknown --ci target instead of writing nothing silently", () => {
  const cwd = sandbox();
  assert.throws(() => init({ ci: "jenkins", cwd }), /unknown --ci target/);
});
