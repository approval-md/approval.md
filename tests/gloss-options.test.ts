import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  glossRunnerFromOptions,
  parseGlossOptions,
  type GlossOptions,
} from "../src/cli/gloss-options.js";
import { spawnGloss, type GlossRunner } from "../src/cli/gloss.js";
import { fakeClaudeEnv } from "./fake-claude.js";

test("surface defaults preserve Claude/Haiku and historical enablement", () => {
  assert.deepEqual(parseGlossOptions({}, false), {
    ok: true,
    options: { enabled: false, provider: "claude", model: "haiku" },
  });
  assert.deepEqual(parseGlossOptions({}, true), {
    ok: true,
    options: { enabled: true, provider: "claude", model: "haiku" },
  });
  assert.deepEqual(parseGlossOptions({ "--gloss": true }, false), {
    ok: true,
    options: { enabled: true, provider: "claude", model: "haiku" },
  });
});

test("no-gloss wins a tie and constructs no provider runner", () => {
  const parsed = parseGlossOptions(
    { "--gloss": true, "--no-gloss": true, "--gloss-model": "sonnet" },
    true,
  );
  assert.deepEqual(parsed, {
    ok: true,
    options: { enabled: false, provider: "claude", model: "sonnet" },
  });
  assert.equal(parsed.ok, true);

  let factories = 0;
  const runner = glossRunnerFromOptions(parsed.options, {
    claudeRunnerFor: () => {
      factories += 1;
      return () => null;
    },
    codexRunnerFor: () => {
      factories += 1;
      return () => null;
    },
  });
  assert.equal(runner, undefined);
  assert.equal(factories, 0);
});

test("Codex selection requires an explicit valid model", () => {
  assert.deepEqual(parseGlossOptions({ "--gloss-provider": "codex" }, true), {
    ok: false,
    message: "--gloss-provider codex requires --gloss-model <model>",
  });
  assert.equal(
    parseGlossOptions(
      { "--no-gloss": true, "--gloss-provider": "codex", "--gloss-model": "   " },
      true,
    ).ok,
    false,
    "disabled options must still reject a latent typo",
  );
  assert.equal(
    parseGlossOptions(
      { "--gloss-provider": "codex", "--gloss-model": `gpt-${"x".repeat(101)}` },
      true,
    ).ok,
    false,
  );
  assert.equal(
    parseGlossOptions(
      { "--gloss-provider": "codex", "--gloss-model": "gpt-5\nignore" },
      true,
    ).ok,
    false,
  );
});

test("unknown providers and malformed typed values fail as usage inputs", () => {
  assert.deepEqual(parseGlossOptions({ "--gloss-provider": "openai" }, true), {
    ok: false,
    message: '--gloss-provider expects claude or codex, got "openai"',
  });
  assert.equal(parseGlossOptions({ "--gloss-provider": true }, true).ok, false);
  assert.equal(parseGlossOptions({ "--gloss-model": true }, true).ok, false);
});

test("the factory passes only the selected provider, model, scrub name and fixed diagnostics", () => {
  const calls: string[] = [];
  const fakeRunner: GlossRunner = () => null;
  const selected: GlossOptions = {
    enabled: true,
    provider: "codex",
    model: "gpt-5.4-mini",
  };
  const runner = glossRunnerFromOptions(selected, {
    passphraseEnv: "CUSTOM_PASSPHRASE",
    diagnostic: (reason) => calls.push(`diagnostic:${reason}`),
    claudeRunnerFor: () => {
      calls.push("claude");
      return fakeRunner;
    },
    codexRunnerFor: (model, passphraseEnv, options) => {
      calls.push(`codex:${model}:${passphraseEnv}`);
      options?.diagnostic?.("timeout");
      return fakeRunner;
    },
  });
  assert.equal(runner, fakeRunner);
  assert.deepEqual(calls, ["codex:gpt-5.4-mini:CUSTOM_PASSPHRASE", "diagnostic:timeout"]);
});

test("Claude selection never constructs the Codex provider", () => {
  const calls: string[] = [];
  const fakeRunner: GlossRunner = () => null;
  const runner = glossRunnerFromOptions(
    { enabled: true, provider: "claude", model: "sonnet" },
    {
      passphraseEnv: "CUSTOM_PASSPHRASE",
      claudeRunnerFor: (passphraseEnv, model) => {
        calls.push(`claude:${model}:${passphraseEnv}`);
        return fakeRunner;
      },
      codexRunnerFor: () => {
        calls.push("codex");
        return fakeRunner;
      },
    },
  );
  assert.equal(runner, fakeRunner);
  assert.deepEqual(calls, ["claude:sonnet:CUSTOM_PASSPHRASE"]);
});

test("a throwing diagnostic remains unable to break runner construction", () => {
  const runner = glossRunnerFromOptions(
    { enabled: true, provider: "codex", model: "gpt-5.4-mini" },
    {
      diagnostic: () => {
        throw new Error("reporter failed");
      },
      codexRunnerFor: (_model, _passphraseEnv, options) => {
        assert.doesNotThrow(() => options?.diagnostic?.("nonzero-exit"));
        return () => null;
      },
    },
  );
  assert.equal(typeof runner, "function");
});

test("the Claude production runner honors an explicit model override", () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-gloss-options-test-"));
  const priorPath = process.env["PATH"];
  try {
    const fake = fakeClaudeEnv(
      dir,
      '[ "$3" = "claude-3-5-haiku" ] || exit 9; echo "Describes the selected command."',
    );
    process.env["PATH"] = fake["PATH"];
    const result = spawnGloss("prompt", null, "claude-3-5-haiku");
    assert.deepEqual(result, {
      text: "Describes the selected command.\n",
      provenance: { provider: "claude", requestedModel: "claude-3-5-haiku" },
    });
  } finally {
    if (priorPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
