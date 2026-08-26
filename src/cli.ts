#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRODUCT_NAME, INVOCATION } from "./name.js";
import { init, report } from "./init.js";
import { newAdr, reportNew } from "./new.js";
import { check } from "./check.js";
import { verify, asVerifyJson, asVerifyTable } from "./verify.js";
import { writeLock, LOCK_FILE } from "./lock.js";
import { briefText, gateFailure } from "./brief.js";
import { loadLedger } from "./ledger.js";
import { readConfig } from "./config-read.js";
import { asJson, asTable } from "./report-check.js";
import { hookResponse, type HookEvent } from "./hook.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string; description: string };

/**
 * v0.0.1 reserves the name and publishes the command surface.
 * The tracer bullet (CLI spec §§5–9) lands in v0.1.0.
 */
/**
 * Never call process.exit() when something has been written to stdout.
 * process.exit() tears the process down without draining a piped write, so
 * output is cut at the OS pipe buffer — 64KB on Linux — and the consumer gets
 * a truncated document. Setting exitCode lets Node flush and exit naturally.
 */
const fail = (message: string, code = 2): void => {
  process.stderr.write(`${PRODUCT_NAME}: ${message}\n`);
  process.exitCode = code;
};

const program = new Command();

program
  .name(PRODUCT_NAME)
  .description(pkg.description)
  .version(pkg.version, "-v, --version")
  .addHelpText(
    "after",
    `\nEnforcement classes\n` +
      `  1  structural   violation impossible by construction\n` +
      `  2  tested       violation fails CI\n` +
      `  3  static       violation fails CI without running code\n` +
      `  4  review-only   no guarantee — requires written justification\n\n` +
      `Quickstart\n  ${INVOCATION} init --claude --ci github\n`,
  );

program
  .command("init")
  .description("scaffold the ADR ledger, config, agent hook and CI gate")
  .option("--claude", "register the PreToolUse hook in .claude/settings.json")
  .option("--ci <system>", "write a CI workflow (github)")
  .action((options: { claude?: boolean; ci?: string }) => {
    const cwd = process.cwd();
    try {
      process.stdout.write(report(init({ ...options, cwd }), cwd) + "\n");
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("new")
  .argument("<title>", "one-sentence statement of the invariant")
  .description("create the next ADR from the template")
  .option("--class <n>", "enforcement class 1-4 (default 4 — unconsidered is unenforced)")
  .option("--symbols <list>", "comma-separated content-match terms")
  .option("--endpoints <list>", "comma-separated API routes, matched on resource segments")
  .action((title: string, options: { class?: string; symbols?: string; endpoints?: string }) => {
    const cwd = process.cwd();
    try {
      process.stdout.write(reportNew(newAdr(title, { ...options, cwd }), cwd) + "\n");
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("check")
  .description("the gate: every accepted ADR must have a live enforcement artifact")
  .option("--json", "machine-readable output (public contract)")
  .action((options: { json?: boolean }) => {
    try {
      const report = check(process.cwd());
      process.stdout.write((options.json ? asJson(report) : asTable(report)) + "\n");
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("ratify")
  .description(`record what is ratified in ${LOCK_FILE} — a human act, not a build step`)
  .action(() => {
    try {
      const cwd = process.cwd();
      const config = readConfig(cwd);
      const { records } = loadLedger(join(cwd, config.adrDir));
      const lock = writeLock(cwd, records);
      const count = Object.keys(lock.adrs).length;
      process.stdout.write(
        [
          `  wrote    ${LOCK_FILE}  (${count} decision${count === 1 ? "" : "s"})`,
          "",
          "From here the gate fails when a decision is weakened without this file",
          "changing to match: a status moved backwards, a class dropped, a Decision",
          "reworded. That is a record until the path is owned — put it behind review",
          "(CODEOWNERS) and it becomes a control.",
        ].join("\n") + "\n",
      );
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("verify")
  .description("execute enforcement: a rule is enforced only when it has been evaluated green")
  .option("--json", "machine-readable output")
  .action((options: { json?: boolean }) => {
    try {
      const report = verify(process.cwd());
      process.stdout.write((options.json ? asVerifyJson(report) : asVerifyTable(report)) + "\n");
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      // Exit 2: a config the gate cannot read is not a green ledger.
      fail((error as Error).message);
    }
  });

program
  .command("brief")
  .description("what the ledger demands — for the agent host's session start, not for you")
  .action(() => {
    // Never break a session. Silence is the failure mode here, and it is safe
    // only because the gate says the same thing where it cannot be missed.
    try {
      const text = briefText(process.cwd());
      if (text === null) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
        }) + "\n",
      );
    } catch {
      // Intentionally silent.
    }
  });

program
  .command("gate")
  .description("refuse to finish while the gate is red — for the agent host's stop event")
  .action(async () => {
    try {
      // The host sets this once it has already forced a continuation. Without
      // honouring it a red gate would refuse every attempt to stop, forever.
      let already = false;
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (raw.length > 0) {
          try {
            already = (JSON.parse(raw) as { stop_hook_active?: boolean }).stop_hook_active === true;
          } catch {
            already = false;
          }
        }
      }
      if (already) return;

      const reason = gateFailure(process.cwd());
      if (reason === null) return;
      // Exit 2 with the reason on stderr is the host's documented way to stop a
      // stop. A JSON decision field would work too and is one field name away
      // from silently doing nothing.
      process.stderr.write(reason + "\n");
      process.exitCode = 2;
    } catch {
      // A gate that cannot run must not trap the session.
    }
  });

program
  .command("hook")
  .description("deterministic context delivery — invoked by the agent host, not by you")
  .action(async () => {
    // Every failure path here exits 0 in silence. This process sits inside the
    // developer's edit loop; a hook that errors takes their session with it,
    // and a governance tool people disable has enforced nothing.
    try {
      if (process.stdin.isTTY) return;
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookEvent;
      const response = hookResponse(event, process.cwd());
      if (response !== null) process.stdout.write(response + "\n");
    } catch {
      // Intentionally silent.
    }
    // No process.exit(): it would truncate the write above at the pipe buffer,
    // handing the host unparseable JSON — the exact opposite of "never break
    // the edit loop". Falling off the end exits 0 once stdout has drained.
  });

program.parse();
