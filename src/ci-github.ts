import { CONFIG_FILE, INVOCATION, PRODUCT_NAME } from "./name.js";

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

export const CONFIG_FILE_NAME = CONFIG_FILE;
