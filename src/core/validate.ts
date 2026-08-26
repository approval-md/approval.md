/**
 * Write-boundary JSON Schema validation.
 *
 * SPEC.md §8: every event and envelope validates against its JSON Schema
 * before it is written. Validation at the write boundary is itself a control,
 * so this module fails **closed**: a missing schema directory, an unreadable
 * or unparseable schema file, an unknown schema id, or an Ajv compile failure
 * all produce `{ ok: false, errors: [...] }`. Nothing here can return `ok`
 * for a document it did not actually validate, and nothing throws out to the
 * caller (a thrown error would be an unhandled write-boundary bypass).
 *
 * Determinism: the result is a pure function of (schema files on disk,
 * document). No network, no clock, no randomness, and no cross-call caching —
 * schemas are re-read and re-compiled per call so a run never depends on the
 * order or history of previous calls.
 *
 * Dialect / import notes (AC #6 — documented, never silently downgraded):
 *
 * - Dialect is JSON Schema draft 2020-12 via Ajv's dedicated `Ajv2020` class.
 *   Ajv 8 ships no `exports` map, so under NodeNext the working ESM import is
 *   the deep path to the built CJS file:
 *       import { Ajv2020 } from "ajv/dist/2020.js";
 *   The named export is used rather than the default because Ajv 8's CJS
 *   interop default (`module.exports = Ajv2020`) is not typed as a default
 *   export under `verbatimModuleSyntax` + `esModuleInterop: false`. The named
 *   binding resolves and type-checks cleanly under NodeNext.
 * - `ajv-formats` is likewise a deep CJS import: its plugin is exported as
 *   `module.exports = formatsPlugin`, so the callable value comes from the
 *   `.default` property of the namespace import under NodeNext.
 * - Ajv is configured `strict: true`. No strict flag is relaxed. Formats are
 *   enforced, not annotation-only: `validateFormats: true` plus `ajv-formats`
 *   registered, so an invalid `date-time` string is a validation error.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

// `ajv-formats` is CJS (`module.exports = formatsPlugin`) shipping ESM-shaped
// type declarations, so under NodeNext + `esModuleInterop: false` TypeScript
// types the import as a module namespace rather than the callable plugin. The
// runtime value carries the plugin on `.default` (the CJS file sets it
// explicitly), so it is narrowed once here and the rest of the module stays
// free of interop noise.
const addFormats = (addFormatsModule as unknown as { default: FormatsPlugin })
  .default;

/** A single validation failure, flattened for logging and CLI output. */
export interface ValidationError {
  /** JSON Pointer to the offending location ("" for the document root). */
  path: string;
  /** Ajv keyword, or a harness pseudo-keyword such as "schemaLoad". */
  keyword: string;
  /** Human-readable reason. */
  message: string;
}

/** Result of a write-boundary validation. Failure always carries a reason. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

/** Suffix identifying schema files inside the schema directory. */
export const SCHEMA_FILE_SUFFIX = ".schema.json";

/** Repo `schema/` directory: default source of truth for all schemas. */
export const DEFAULT_SCHEMA_DIR = fileURLToPath(
  new URL("../../../schema/", import.meta.url),
);

/**
 * Which boundary a validation is speaking for (APRV-121).
 *
 * - `write` — the default, and what SPEC.md §8 means by "validate at the write
 *   boundary". The schemas as written on disk: a monetary amount is a canonical
 *   decimal string and nothing else.
 * - `historical` — the read boundary. The log is append-only, so a verifier
 *   walking records written before APRV-121 meets JSON-number amounts that were
 *   valid when they were appended and must stay valid forever. This mode makes
 *   exactly one substitution, described in {@link WIDENED_DEFS}, and no other.
 *
 * The asymmetry is the point: a document only ever gets *more* permissive by a
 * caller explicitly naming the read boundary, and only `core/verify.ts` does.
 */
export type ValidationMode = "write" | "historical";

/** Options accepted by {@link validate}. */
export interface ValidateOptions {
  /** Directory to load `*.schema.json` from. Injectable for tests. */
  schemaDir?: string;
  /** Which boundary this validation speaks for. Defaults to `"write"`. */
  mode?: ValidationMode;
}

/**
 * The `$defs` a `historical` validation replaces, as `name -> replacement name`.
 *
 * Pinned as a list rather than derived from a naming convention, so widening
 * the read boundary is always a reviewable diff in this file and never a side
 * effect of adding a definition to a schema. `usd_amount` is the only entry:
 * the pre-APRV-121 write boundary typed monetary fields as `{"type": "number",
 * "minimum": 0}`, and `usd_amount_historical` is exactly that union with the
 * decimal string.
 */
export const WIDENED_DEFS: Readonly<Record<string, string>> = {
  usd_amount: "usd_amount_historical",
};

/**
 * A schema with the {@link WIDENED_DEFS} substitutions applied, or the schema
 * unchanged when it defines none of them.
 *
 * Deterministic and shallow: only the named `$defs` entries are swapped, the
 * document's own keywords are untouched, and a schema missing a replacement
 * definition is left strict rather than silently loosened.
 */
function widenHistorical(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = schema["$defs"];
  if (typeof defs !== "object" || defs === null || Array.isArray(defs)) return schema;
  const source = defs as Record<string, unknown>;
  let changed = false;
  const widened: Record<string, unknown> = { ...source };
  for (const [name, replacement] of Object.entries(WIDENED_DEFS)) {
    if (!Object.hasOwn(source, name) || !Object.hasOwn(source, replacement)) continue;
    widened[name] = source[replacement];
    changed = true;
  }
  return changed ? { ...schema, $defs: widened } : schema;
}

function failure(
  keyword: string,
  message: string,
  path = "",
): { ok: false; errors: ValidationError[] } {
  return { ok: false, errors: [{ path, keyword, message }] };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * List schema names (file basename minus `.schema.json`) in a directory.
 * Sorted, so discovery order is stable across platforms and runs.
 */
export function listSchemaNames(schemaDir: string = DEFAULT_SCHEMA_DIR): string[] {
  let entries: string[];
  try {
    entries = readdirSync(schemaDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(SCHEMA_FILE_SUFFIX))
    .map((entry) => basename(entry, SCHEMA_FILE_SUFFIX))
    .sort();
}

interface LoadedSchema {
  name: string;
  schema: Record<string, unknown>;
}

type LoadOutcome =
  | { ok: true; schemas: LoadedSchema[] }
  | { ok: false; errors: ValidationError[] };

/**
 * Read and JSON-parse every schema in `schemaDir`. Any unreadable or
 * unparseable file fails the whole load: a partially-loaded schema set could
 * silently drop a `$ref` target and let a bad document through.
 */
function loadSchemas(schemaDir: string): LoadOutcome {
  let entries: string[];
  try {
    entries = readdirSync(schemaDir);
  } catch (cause) {
    return failure(
      "schemaDir",
      `schema directory ${schemaDir} could not be read: ${errorMessage(cause)}`,
    );
  }

  const names = entries
    .filter((entry) => entry.endsWith(SCHEMA_FILE_SUFFIX))
    .sort();

  const schemas: LoadedSchema[] = [];
  for (const entry of names) {
    const file = join(schemaDir, entry);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (cause) {
      return failure(
        "schemaLoad",
        `schema file ${entry} could not be read: ${errorMessage(cause)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      return failure(
        "schemaParse",
        `schema file ${entry} is not valid JSON: ${errorMessage(cause)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return failure(
        "schemaParse",
        `schema file ${entry} must contain a JSON object at the top level`,
      );
    }
    schemas.push({
      name: basename(entry, SCHEMA_FILE_SUFFIX),
      schema: parsed as Record<string, unknown>,
    });
  }

  return { ok: true, schemas };
}

type CompileOutcome =
  | { ok: true; validateFn: ValidateFunction }
  | { ok: false; errors: ValidationError[] };

/**
 * Build a fresh Ajv 2020-12 instance holding every schema in the directory
 * (so cross-schema `$ref` by `$id` resolves) and compile the requested one.
 */
function compileSchema(
  schemaDir: string,
  schemaId: string,
  mode: ValidationMode,
): CompileOutcome {
  const raw = loadSchemas(schemaDir);
  if (!raw.ok) return raw;
  const loaded: LoadOutcome =
    mode === "historical"
      ? {
          ok: true,
          schemas: raw.schemas.map((entry) => ({
            name: entry.name,
            schema: widenHistorical(entry.schema),
          })),
        }
      : raw;
  if (!loaded.ok) return loaded;

  const target = loaded.schemas.find(
    (candidate) =>
      candidate.name === schemaId || candidate.schema["$id"] === schemaId,
  );
  if (target === undefined) {
    return failure(
      "unknownSchema",
      `unknown schema id "${schemaId}" (searched ${schemaDir})`,
    );
  }

  let ajv: Ajv2020;
  try {
    ajv = new Ajv2020({
      strict: true,
      allErrors: true,
      validateFormats: true,
    });
    addFormats(ajv);
  } catch (cause) {
    return failure(
      "ajvInit",
      `Ajv could not be initialised: ${errorMessage(cause)}`,
    );
  }

  try {
    for (const entry of loaded.schemas) {
      if (entry.name === target.name) continue;
      ajv.addSchema(entry.schema);
    }
    return { ok: true, validateFn: ajv.compile(target.schema) };
  } catch (cause) {
    return failure(
      "schemaCompile",
      `schema "${schemaId}" could not be compiled: ${errorMessage(cause)}`,
    );
  }
}

function toValidationError(error: ErrorObject): ValidationError {
  return {
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "validation failed",
  };
}

/**
 * Validate `document` against the schema identified by `schemaId` (the schema
 * filename minus `.schema.json`, or the schema's `$id`).
 *
 * Fails closed: every load, parse, and compile problem is reported as a
 * validation failure rather than thrown.
 */
export function validate(
  schemaId: string,
  document: unknown,
  options: ValidateOptions = {},
): ValidationResult {
  const schemaDir = options.schemaDir ?? DEFAULT_SCHEMA_DIR;

  const compiled = compileSchema(schemaDir, schemaId, options.mode ?? "write");
  if (!compiled.ok) return compiled;

  let valid: boolean;
  try {
    valid = compiled.validateFn(document) as boolean;
  } catch (cause) {
    // Ajv only throws here for $ref resolution problems in async/dynamic
    // schemas; treat it as a rejection, never as a pass.
    return failure(
      "validationError",
      `validation of "${schemaId}" failed to run: ${errorMessage(cause)}`,
    );
  }

  if (valid) return { ok: true };

  const errors = (compiled.validateFn.errors ?? []).map(toValidationError);
  return {
    ok: false,
    errors:
      errors.length > 0
        ? errors
        : [
            {
              path: "",
              keyword: "unknown",
              message: `document did not validate against "${schemaId}"`,
            },
          ],
  };
}
