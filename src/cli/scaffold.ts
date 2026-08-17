/**
 * The bytes `approval init` scaffolds, and the one-line rationale for each.
 *
 * These constants live apart from both `init.ts` and `help.ts` because both
 * need them: the verb writes them and the help text quotes them, and a help text
 * that quoted a stale copy would be the second-worst kind of documentation — the
 * confident kind. One definition, two readers, no cycle.
 */

/**
 * SPEC.md §5.1's canonical example, byte for byte.
 *
 * This constant and `schema/fixtures/policy-md/valid/canonical.md` are the same
 * bytes, and `tests/cli-init.test.ts` asserts it: the fixture is frozen (every
 * policy-loading test descends from it) and the spec section it transcribes is
 * what a reader compares the scaffolded file against. A copy that drifted from
 * either would hand a new user a policy the documentation does not describe.
 *
 * It is embedded here rather than read from `schema/` because the published
 * package ships the CLI and the spec, not the test fixtures, and a scaffolding
 * verb that fails on an installed copy is a verb that only ever worked in this
 * checkout.
 *
 * The closing sentence is not in SPEC.md §5.1's fence — it is the fixture's own
 * trailing prose, kept because it says the one thing a first-time reader of this
 * file needs to know: the prose is not the policy.
 */
export const CANONICAL_POLICY = `# Approval Policy

Agents working in this project handle my life admin. Anything that leaves
the machine gets declared, and the classes below say what I sign off on.

\`\`\`yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual          # unknown/undeclared classes require sign-off
  channel: telegram
  approval_ttl: 24h         # pending requests expire
  on_expiry: reject

approvers:
  carter:
    channels: [telegram, cli]

classes:
  read.*:                       { autonomy: autonomous }
  files.write.workspace:        { autonomy: autonomous }
  calendar.write.own:           { autonomy: supervised }
  communicate.email.draft:      { autonomy: autonomous }
  communicate.email.external:
    autonomy: manual
    approvers: [carter]
  financial.spend:
    autonomy: manual
    approvers: [carter]
    limits: { per_action_usd: 25, daily_usd: 100 }
  public.post:                  { autonomy: manual }
  data.delete:                  { autonomy: manual }
  account.auth:                 { autonomy: manual }

budgets:
  global: { daily_usd: 100, daily_actions: 200 }

audit:
  supervised_sample_rate: 0.10   # fraction of supervised actions escalated
                                 # for retrospective human review

channels:
  telegram:
    chat_id_env: APPROVAL_TG_CHAT
    token_env: APPROVAL_TG_TOKEN
  web:
    port: 4680
\`\`\`

Everything after the block is prose again and is ignored by the parser.
`;

/**
 * The comment the merged `.gitignore` lines live under.
 *
 * A marker rather than a bare append, so a second `init` can tell its own lines
 * from the operator's and add only what is missing, and so a human reading the
 * file knows which lines they are allowed to delete.
 */
export const GITIGNORE_MARKER = "# approval.md";

/**
 * The ignore lines, and why each one is there.
 *
 * - `.approval/*.sqlite` — the index is a projection (SPEC.md §9.2). It rebuilds
 *   from the log with `approval reindex`; committing it would put a cache in the
 *   history of the thing it caches.
 * - `.approval/vault.enc` — the encrypted credential store (M7). Encrypted or
 *   not, the vault is the one file in the layout whose contents are secrets, and
 *   secrets do not go in a repository.
 * - `.approval/**\/*.tmp-*` — the atomic-write temp files. Both writers that
 *   rename into place (`channels/render-queue.ts`, `core/payload-store.ts`) name
 *   their temp `.<basename>.tmp-<pid>-<counter>`, so this pattern is written to
 *   match what those two actually produce, at both levels of the tree. A crashed
 *   write leaves one behind; nobody should be asked to review it.
 *
 * `.approval/log/` is deliberately absent: the log is the truth and belongs in
 * the history. So is `.approval/payloads/`, which holds the bytes each approval
 * bound to — evidence defaults to tracked, and the next steps `init` prints say
 * so, along with the one line that reverses the choice.
 */
export const GITIGNORE_ENTRIES: readonly string[] = [
  ".approval/*.sqlite",
  ".approval/vault.enc",
  ".approval/**/*.tmp-*",
];

/** The same entries, indented for the help text so the two cannot disagree. */
export const GITIGNORE_ENTRY_LINES = GITIGNORE_ENTRIES.join("\n                      ");
