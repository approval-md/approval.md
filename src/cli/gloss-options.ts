/** Shared provider selection for the three optional gloss surfaces (APRV-255). */

import { boolFlag, type ParsedFlags } from "./args.js";
import { codexGlossRunnerFor, type CodexGlossUnavailableReason } from "./gloss-codex.js";
import {
  GLOSS_MODEL,
  GLOSS_MODEL_ID_MAX_CHARS,
  glossRunnerFor,
  normalizeGlossModelId,
  type GlossProvider,
  type GlossRunner,
} from "./gloss.js";

/** A validated operator selection. It is safe to hand directly to a runner factory. */
export interface GlossOptions {
  readonly enabled: boolean;
  readonly provider: GlossProvider;
  readonly model: string;
}

export type GlossOptionsResult =
  | { readonly ok: true; readonly options: GlossOptions }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the flags shared by `up`, Telegram listen and the terminal channel.
 *
 * The caller supplies its historical default: Telegram and `up` pass `true`,
 * while the terminal channel passes `false`. `--no-gloss` wins a tie so an
 * explicit request to remove a model from the path can never accidentally
 * spawn one. Provider and model values are validated even when disabled;
 * otherwise a typo could wait unnoticed until a later invocation adds
 * `--gloss`.
 */
export function parseGlossOptions(
  flags: ParsedFlags,
  enabledByDefault: boolean,
): GlossOptionsResult {
  const providerValue = flags["--gloss-provider"];
  if (
    providerValue !== undefined &&
    (typeof providerValue !== "string" ||
      (providerValue !== "claude" && providerValue !== "codex"))
  ) {
    return {
      ok: false,
      message: `--gloss-provider expects claude or codex, got ${JSON.stringify(providerValue)}`,
    };
  }
  const provider: GlossProvider = providerValue ?? "claude";

  const modelValue = flags["--gloss-model"];
  if (modelValue !== undefined && typeof modelValue !== "string") {
    return {
      ok: false,
      message: `--gloss-model expects a model identifier, got ${JSON.stringify(modelValue)}`,
    };
  }
  if (provider === "codex" && modelValue === undefined) {
    return {
      ok: false,
      message: "--gloss-provider codex requires --gloss-model <model>",
    };
  }
  const model = normalizeGlossModelId(modelValue ?? GLOSS_MODEL);
  if (model === null) {
    return {
      ok: false,
      message:
        `--gloss-model expects a nonblank model identifier of at most ${GLOSS_MODEL_ID_MAX_CHARS} letters, numbers, or . _ : / + - characters`,
    };
  }

  return {
    ok: true,
    options: {
      enabled:
        !boolFlag(flags, "--no-gloss") &&
        (boolFlag(flags, "--gloss") || enabledByDefault),
      provider,
      model,
    },
  };
}

type ClaudeRunnerFactory = (passphraseEnv: string | null, model: string) => GlossRunner;
type CodexRunnerFactory = typeof codexGlossRunnerFor;

/** Fixed reason codes only; subprocess output must never reach this callback. */
export type GlossDiagnostic = (reason: CodexGlossUnavailableReason) => void;

export interface GlossRunnerFactoryOptions {
  readonly passphraseEnv?: string | null;
  readonly diagnostic?: GlossDiagnostic;
  /** Test seams. Production callers use the provider implementations above. */
  readonly claudeRunnerFor?: ClaudeRunnerFactory;
  readonly codexRunnerFor?: CodexRunnerFactory;
}

/** Construct exactly the selected runner, or no runner when glossing is disabled. */
export function glossRunnerFromOptions(
  selection: GlossOptions,
  factoryOptions: GlossRunnerFactoryOptions = {},
): GlossRunner | undefined {
  if (!selection.enabled) return undefined;
  const passphraseEnv = factoryOptions.passphraseEnv ?? null;
  if (selection.provider === "claude") {
    return (factoryOptions.claudeRunnerFor ?? glossRunnerFor)(passphraseEnv, selection.model);
  }

  const runnerFor = factoryOptions.codexRunnerFor ?? codexGlossRunnerFor;
  const diagnostic = factoryOptions.diagnostic;
  return runnerFor(
    selection.model,
    passphraseEnv,
    diagnostic === undefined
      ? {}
      : {
          diagnostic: (reason) => {
            try {
              diagnostic(reason);
            } catch {
              // Reporting an absent convenience cannot break prompt dispatch.
            }
          },
        },
  );
}
