/**
 * The product name, in exactly one place.
 *
 * CLI spec §1: "code must not hard-code the name outside one constant."
 * That is not a style preference — it is what makes the name decision cheap
 * to reverse. Every user-facing string, filename and config key below derives
 * from PRODUCT_NAME, so a rename is a one-line change.
 */
export const PRODUCT_NAME = "harmost";

/** Config file created by `init` in the host repo. */
export const CONFIG_FILE = `${PRODUCT_NAME}.yaml`;

/** Directory holding the ADR ledger, relative to the host repo root. */
export const DEFAULT_ADR_DIR = "adr";

/** Invocation shown in help text and error messages. */
export const INVOCATION = `npx ${PRODUCT_NAME}`;
