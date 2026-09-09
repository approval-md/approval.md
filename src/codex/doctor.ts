import { resolve } from "node:path";

import { checkCodexInstance, readCodexInstance } from "./manifest.js";
import { diagnoseCodexInstance, type DoctorReport, type TrustOptions } from "./trust.js";

export type StrictDoctorResult =
  | { ok: true; ready: true; report: DoctorReport }
  | { ok: false; ready: false; code: string; message: string; report?: DoctorReport };

export function strictDoctor(path: string, options: TrustOptions = {}): StrictDoctorResult {
  const actualPath = resolve(path);
  const read = readCodexInstance(actualPath);
  if (!read.ok) {
    return {
      ok: false,
      ready: false,
      code: "manifest-invalid",
      message: read.errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; "),
    };
  }
  if (read.manifest.paths.manifest !== actualPath) {
    return {
      ok: false,
      ready: false,
      code: "manifest-path-drift",
      message: `manifest was read from ${actualPath}, but pins ${read.manifest.paths.manifest}`,
    };
  }
  const checked = checkCodexInstance(read.manifest);
  if (!checked.ok) {
    return {
      ok: false,
      ready: false,
      code: "manifest-invalid",
      message: checked.errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; "),
    };
  }
  const report = diagnoseCodexInstance(checked.manifest, options);
  return {
    ok: false,
    ready: false,
    code: "codex-not-ready",
    message: "strict Codex enforcement is not ready; inspect findings",
    report,
  };
}
