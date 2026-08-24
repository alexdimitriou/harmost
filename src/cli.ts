#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRODUCT_NAME, INVOCATION } from "./name.js";
import { init, report } from "./init.js";
import { newAdr, reportNew } from "./new.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string; description: string };

/**
 * v0.0.1 reserves the name and publishes the command surface.
 * The tracer bullet (CLI spec §§5–9) lands in v0.1.0.
 */
const NOT_YET = (command: string): void => {
  process.stderr.write(
    `${PRODUCT_NAME}: \`${command}\` is not implemented in v${pkg.version}.\n` +
      `This release reserves the name and publishes the command surface.\n` +
      `The tracer bullet — init, new, check, hook — lands in v0.1.0.\n`,
  );
  process.exit(2);
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
      process.stderr.write(`${PRODUCT_NAME}: ${(error as Error).message}\n`);
      process.exit(2);
    }
  });

program
  .command("new")
  .argument("<title>", "one-sentence statement of the invariant")
  .description("create the next ADR from the template")
  .option("--class <n>", "enforcement class 1-4 (default 4 — unconsidered is unenforced)")
  .option("--symbols <list>", "comma-separated content-match terms")
  .action((title: string, options: { class?: string; symbols?: string }) => {
    const cwd = process.cwd();
    try {
      process.stdout.write(reportNew(newAdr(title, { ...options, cwd }), cwd) + "\n");
    } catch (error) {
      process.stderr.write(`${PRODUCT_NAME}: ${(error as Error).message}\n`);
      process.exit(2);
    }
  });

program
  .command("check")
  .description("the gate: every accepted ADR must have a live enforcement artifact")
  .option("--json", "machine-readable output (public contract)")
  .action(() => NOT_YET("check"));

program
  .command("hook")
  .description("deterministic context delivery — invoked by the agent host, not by you")
  .action(() => NOT_YET("hook"));

program.parse();
