/**
 * A mock adapter, for the conformance suite to have something to hold to the
 * standard (APRV-67).
 *
 * It is deliberately the *shape* of a real one and none of the substance: it
 * serves one class, it needs one credential and refuses to act without it, and
 * it "sends" by pushing the payload into an array the test can read. What it
 * does not do is anything the contract already owns — no token handling, no log
 * reads, no appends, no hashing. An adapter that reached for any of those would
 * be reimplementing the boundary it is supposed to sit behind.
 *
 * Not a test file (no `.test.ts` suffix), so the runner ignores it. Same role
 * `tests/telegram-mock.ts` plays for the channel suite.
 */

import type {
  ActInput,
  ActOutcome,
  Adapter,
  JsonValue,
} from "../src/adapters/contract.js";

/** The class this mock serves. */
export const MOCK_CLASS = "communicate.email.external";

/** The credential it needs. The conformance harness stocks a provider with it. */
export const MOCK_CREDENTIAL = "mock-email-api-key";

/** One "send" the mock performed, for a test to inspect. */
export interface MockSend {
  actionKey: string;
  payload: JsonValue;
  /** Whether the credential was reachable at act time. Never its value. */
  authenticated: boolean;
}

export interface MockAdapter extends Adapter {
  /** Everything this instance sent, in order. */
  readonly sends: MockSend[];
}

export interface MockAdapterOptions {
  /** Report this failure instead of sending. */
  fail?: { code: string; message: string };
  /** Throw this message instead of returning. Exercises the catch path. */
  throws?: string;
  /** Put this string in the returned detail — the leak the guard must catch. */
  leak?: string;
}

/**
 * A fresh mock adapter.
 *
 * The credential is fetched, checked, and then *not kept*: the value is never
 * stored on the instance, never returned, and never put in the detail (except
 * through {@link MockAdapterOptions.leak}, which exists so a test can watch the
 * redaction guard catch a careless adapter).
 */
export function mockAdapter(options: MockAdapterOptions = {}): MockAdapter {
  const sends: MockSend[] = [];
  return {
    name: "mock-email",
    classes: [MOCK_CLASS],
    // APRV-169: the one credential it cannot act without, declared so the
    // contract resolves it before it consumes the token.
    requiredCredentials: [MOCK_CREDENTIAL],
    sends,
    act(input: ActInput): ActOutcome {
      const credential = input.credentials.get(MOCK_CREDENTIAL);
      if (!credential.ok) {
        return {
          ok: false,
          code: credential.code,
          message: `mock-email cannot send without ${MOCK_CREDENTIAL}: ${credential.message}`,
        };
      }
      if (options.throws !== undefined) throw new Error(options.throws);
      if (options.fail !== undefined) {
        return { ok: false, code: options.fail.code, message: options.fail.message };
      }
      sends.push({ actionKey: input.actionKey, payload: input.payload, authenticated: true });
      return {
        ok: true,
        detail: {
          sent: true,
          ...(options.leak === undefined ? {} : { note: `key=${options.leak}` }),
        },
      };
    },
  };
}
