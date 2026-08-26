import { CONFIG_FILE, INVOCATION, PRODUCT_NAME } from "./name.js";
import { LOCK_FILE } from "./lock.js";

export const WORKFLOW_PATH = `.github/workflows/${PRODUCT_NAME}.yml`;

/**
 * The gate, as a workflow. Deliberately trivial: the gate is a plain CLI
 * command, so this file carries no logic worth maintaining. Any other CI
 * system needs one line — run `${INVOCATION} check`.
 */
export const GITHUB_WORKFLOW = `name: ${PRODUCT_NAME}

on:
  pull_request:

jobs:
  check:
    name: invariant coverage
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - name: ${PRODUCT_NAME} check
        run: ${INVOCATION} check
`;

export const CODEOWNERS_PATH = ".github/CODEOWNERS";

/**
 * The other half of the lock.
 *
 * A lock records what was ratified; ownership is what stops the author of a
 * change from also being the one who un-ratifies. Without it the gate reports
 * a weakening to the same person who wanted it, which is a record rather than
 * a control.
 *
 * Written with a placeholder on purpose. An owner this repository has not
 * chosen is not an owner, and a name invented here would read as protection
 * that is not there.
 */
export const codeowners = (adrDir: string): string => `# Who ratifies.
#
# These paths decide what is held and how strongly. A pull request that weakens
# a decision — moving it back to \`proposed\`, dropping its class, rewording what
# was ratified — changes one of them, and ${PRODUCT_NAME} reports it. Ownership is
# what makes someone other than the author have to agree.
#
# REPLACE @OWNER with the architect or team who ratifies. Until you do, these
# lines match nobody and nothing is required to merge.

${adrDir}/           @OWNER
${LOCK_FILE}      @OWNER
${CONFIG_FILE}      @OWNER
`;

export const CONFIG_FILE_NAME = CONFIG_FILE;
