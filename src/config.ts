import { CONFIG_FILE, DEFAULT_ADR_DIR, PRODUCT_NAME } from "./name.js";

/** Tools whose edits the hook inspects. Verified against the Claude Code hook docs. */
export const HOOK_TOOLS = ["Edit", "Write", "MultiEdit"] as const;

/**
 * Total characters of decision text injected per hook event.
 *
 * Bytes rather than a count, because bytes are the resource. A count cap has to
 * choose which decisions to drop, and only matched ones can be ranked — a cited
 * decision has no order but the one its author typed, so capping that list is
 * arbitrary truncation wearing policy's clothes.
 *
 * Roughly nine decisions at the per-Decision cap. Generous on purpose: whatever
 * this number is, exceeding it now says so rather than quietly reporting fewer
 * rules than cover the edit.
 */
export const MAX_INJECTED_CHARS = 12000;

/** Legacy count cap. Unset by default now; the byte budget is the real bound. */
export const MAX_INJECTED_ADRS = 3;

/**
 * Cap on ADRs injected because a matched one cites them.
 *
 * A separate budget on purpose. `max_injected_adrs` selects among decisions the
 * edit itself reaches; a cited decision was chosen by another ADR's author, and
 * letting it compete would drop a rule matching the code being written in
 * favour of one that does not.
 */
export const MAX_INJECTED_CITATIONS = 2;

export const DEFAULT_CONFIG = `# ${PRODUCT_NAME} — configuration
# Source of truth is this repo's git tree. Nothing here is a cache.
version: 1

# Where the ADR ledger lives.
adr_dir: ${DEFAULT_ADR_DIR}

# Where enforced-by test artifacts are allowed to live.
test_globs:
  - "tests/**"
  - "**/*.test.*"
  - "**/*.spec.*"

hook:
  # Agent tools whose edited text is matched against ADR symbols.
  tools: [${HOOK_TOOLS.join(", ")}]
  # The bound on delivery is the total size of what is injected, not how many
  # decisions it is. Anything that does not fit is named rather than dropped in
  # silence, so an agent is never told fewer rules cover its edit than do.
  max_injected_chars: ${MAX_INJECTED_CHARS}
  # Optional count caps. Unset means every decision that matches, and every one
  # they cite, subject to the budget above.
  # max_injected_adrs: ${MAX_INJECTED_ADRS}
  # max_injected_citations: ${MAX_INJECTED_CITATIONS}
`;

export const CONFIG_PATH = CONFIG_FILE;
