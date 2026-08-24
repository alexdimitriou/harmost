import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { INVOCATION } from "./name.js";
import { readConfig } from "./config-read.js";
import { writeIfAbsent } from "./scaffold.js";
import {
  bodyOfTemplate,
  formatId,
  nextId,
  parseClass,
  parseSymbols,
  renderFrontmatter,
  slugify,
} from "./adr.js";

export interface NewOptions {
  class?: string;
  symbols?: string;
  cwd?: string;
  today?: string;
}

export interface NewResult {
  id: string;
  path: string;
  enforcementClass: 1 | 2 | 3 | 4;
}

function template(root: string, adrDir: string): string {
  const local = join(root, adrDir, "TEMPLATE.md");
  if (existsSync(local)) return readFileSync(local, "utf8");
  // Fall back to the packaged template if the repo's copy was deleted.
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "templates", "ADR-TEMPLATE.md"), "utf8");
}

export function newAdr(title: string, options: NewOptions = {}): NewResult {
  const root = options.cwd ?? process.cwd();
  if (title.trim().length === 0) throw new Error("an ADR needs a title — state the rule in one sentence");

  const config = readConfig(root);
  const enforcementClass = parseClass(options.class);
  const adrDirPath = join(root, config.adrDir);

  const id = formatId(nextId(adrDirPath));
  const path = join(adrDirPath, `${id}-${slugify(title)}.md`);

  const seed = {
    id,
    title: title.trim(),
    enforcementClass,
    symbols: parseSymbols(options.symbols),
    date: options.today ?? new Date().toISOString().slice(0, 10),
  };
  const content = `${renderFrontmatter(seed)}\n\n${bodyOfTemplate(template(root, config.adrDir))}`;

  // Unreachable while nextId holds its contract (it always returns max+1, so the
  // computed path cannot already exist). Kept because write-if-absent is the
  // primitive everywhere in this tool: a decision record is never overwritten,
  // and that property should not depend on another function staying correct.
  const written = writeIfAbsent(path, content);
  if (written.outcome === "skipped") {
    throw new Error(`${path} already exists — refusing to overwrite an existing decision`);
  }
  return { id, path, enforcementClass };
}

export function reportNew(result: NewResult, root: string): string {
  const rel = result.path.startsWith(root) ? result.path.slice(root.length + 1) : result.path;
  const lines = [`  created  ${rel}`, "", `${result.id} is \`proposed\`. The gate ignores it until it is accepted.`];

  if (result.enforcementClass === 4) {
    lines.push(
      "",
      "Enforcement class 4 — nothing but human attention holds this.",
      "Before accepting it, answer in the ADR: why is this NOT class 1?",
      "Accepting at class 4 requires a written justification.",
    );
  } else {
    lines.push(
      "",
      `Class ${result.enforcementClass}: fill in \`enforced-by\` with the artifact that holds it,`,
      `then set \`status: accepted\`. \`${INVOCATION} check\` fails until that artifact resolves.`,
    );
  }
  return lines.join("\n");
}
