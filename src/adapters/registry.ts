/**
 * The built-in adapters, keyed by the classes they serve (APRV-205).
 *
 * One question is asked of this module and one only: **which credential names
 * did the adapter for this class declare it cannot act without?** `approval
 * run` asks it before it spawns, because those names are the ones the scrub in
 * `core/child-env.ts` lets through into the child's environment; everything
 * else under the credential-bearing prefixes is withheld.
 *
 * The declaration is the adapter's own, static, and reached through no flag.
 * That is the point: a caller-supplied list of variables to keep would be a
 * caller-supplied way to get the token back, which is the hole this task
 * closes rather than a feature of the fix.
 *
 * The list is deliberately tiny and deliberately here rather than in
 * `src/core/`: core does not know about adapters and must not learn, so the
 * lookup lives beside the adapters and the CLI does the joining.
 */

import { emailAdapter } from "./email.js";
import type { Adapter } from "./contract.js";

/**
 * Every adapter this build ships. Constructed with defaults: the question asked
 * here is about DECLARED names, and no default answers it differently from a
 * configured instance except by renaming vault entries, which is a deployment's
 * own business and not a reason to open a socket at lookup time.
 */
function builtInAdapters(): readonly Adapter[] {
  return [emailAdapter()];
}

/**
 * The credential names declared by the built-in adapter serving `cls`, or an
 * empty list when no adapter serves it.
 *
 * Every adapter that serves the class contributes, because "which adapter would
 * have run this" is a question with no answer at this point in the flow, and
 * the union of two adapters' declarations is the honest superset. In this build
 * there is one adapter, and it serves one class.
 */
export function declaredCredentialsForClass(cls: string): readonly string[] {
  const names: string[] = [];
  for (const adapter of builtInAdapters()) {
    if (!adapter.classes.includes(cls)) continue;
    for (const name of adapter.requiredCredentials ?? []) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}
