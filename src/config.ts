import { CONFIG_FILE, DEFAULT_ADR_DIR, PRODUCT_NAME } from "./name.js";

/** Tools whose edits the hook inspects. Verified against the Claude Code hook docs. */
export const HOOK_TOOLS = ["Edit", "Write", "MultiEdit"] as const;

/** Cap on ADRs injected per hook event, so context delivery stays bounded. */
export const MAX_INJECTED_ADRS = 3;

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
  # Most-specific-first; anything beyond this cap is not injected.
  max_injected_adrs: ${MAX_INJECTED_ADRS}
`;

export const CONFIG_PATH = CONFIG_FILE;
