/**
 * Whole-word containment.
 *
 * Extracted so the gate and the rule evaluator cannot drift on what "this
 * symbol appears in this file" means. Two answers to that question is two
 * gates holding two different opinions about the same ledger, and the one
 * that disagrees is the one nobody is running.
 */
export function containsTerm(source: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(source);
}
