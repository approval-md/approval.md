#!/usr/bin/env node
/** Synthetic local transport probe. This never contacts muse.ai. */
const base = process.env.APPROVAL_MUSE_LOCAL_URL;
const read = process.env.APPROVAL_MUSE_READ_TOKEN;
const propose = process.env.APPROVAL_MUSE_PROPOSE_TOKEN;
if (!base || !read || !propose || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(base)) {
  process.stderr.write("Set APPROVAL_MUSE_LOCAL_URL to a loopback HTTP URL and both launch credentials.\n");
  process.exitCode = 2;
} else {
  const cases = [
    ["read-pending", "/v1/pending", read, undefined, 200],
    ["propose-cannot-read", "/v1/pending", propose, undefined, 403],
    ["read-cannot-propose", "/v1/registrations", read, {}, 403],
    ["no-native-grant", "/v1/grant", read, {}, 404],
    ["no-native-reject", "/v1/reject", propose, {}, 404],
    ["no-export", "/v1/export", read, {}, 404],
    ["no-arbitrary-verbs", "/verbs", propose, {}, 404],
  ];
  const results = [];
  for (const [name, path, token, value, expected] of cases) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: value === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...(value === undefined ? {} : { "content-type": "application/json" }) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        signal: AbortSignal.timeout(3000),
      });
      results.push({ name, expected, actual: response.status, pass: response.status === expected });
    } catch {
      results.push({ name, expected, actual: "transport-error", pass: false });
    }
  }
  const pass = results.every((item) => item.pass);
  process.stdout.write(`${JSON.stringify({ provenance: "LOCAL_SYNTHETIC_ONLY", native_muse_api_tested: false, native_confirmation_tested: false, results, pass })}\n`);
  process.exitCode = pass ? 0 : 1;
}
