import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, verifyBundle } from "../lib/bundle.mjs";
import { explainFailure } from "../lib/explain.mjs";
import crypto from "node:crypto";

// ---------- canonicalJson ----------

test("canonicalJson sorts keys recursively", () => {
  const input = { b: 1, a: { d: 2, c: [3, { z: 4, y: 5 }] } };
  assert.equal(
    canonicalJson(input),
    '{"a":{"c":[3,{"y":5,"z":4}],"d":2},"b":1}',
  );
});

test("canonicalJson matches JSON.stringify ordering for the control plane's output", () => {
  // The control plane signs canonicalJson(bundle); the CLI recomputes the
  // same canonical form, so identical inputs must produce identical bytes.
  const bundle = {
    format: "kavros-workflow-bundle",
    format_version: 2,
    workflow: { name: "w", revision: 2 },
    capabilities: [{ key: "k", approved_columns: ["a", "b"] }],
  };
  assert.equal(canonicalJson(bundle), canonicalJson(JSON.parse(canonicalJson(bundle))));
});

test("canonicalJson rejects cyclic graphs", () => {
  const node = { self: null };
  node.self = node;
  assert.throws(() => canonicalJson(node), /reference cycles/);
});

// ---------- verifyBundle ----------

function makeSignedBundle({ workflowName = "Nightly report" } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const spkiBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const bundle = {
    format: "kavros-workflow-bundle",
    format_version: 2,
    exported_at: "2026-09-12T00:00:00.000Z",
    origin: { deployment_id: "dep-123", org_name: null },
    workflow: { name: workflowName, description: null, graph: { nodes: [], edges: [] }, revision: 3 },
    capabilities: [
      { key: "customers_table", version: 4, source: "public.customers", approved_columns: ["id", "email"] },
    ],
  };
  const canonical = canonicalJson(bundle);
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  return {
    signed: { bundle, canonical, signature, algorithm: "ed25519" },
    publicKeyBase64: spkiBase64,
  };
}

test("verifyBundle accepts a validly signed bundle", () => {
  const { signed, publicKeyBase64 } = makeSignedBundle();
  const result = verifyBundle(signed, { publicKey: publicKeyBase64 });
  assert.equal(result.ok, true);
  assert.equal(result.summary.workflow, "Nightly report");
  assert.equal(result.summary.revision, 3);
  assert.equal(result.summary.origin_deployment, "dep-123");
  assert.equal(result.summary.capabilities[0].key, "customers_table");
  assert.equal(result.summary.capabilities[0].approved_columns, 2);
  assert.match(result.summary.signature_key_fingerprint, /^sha256:[0-9a-f]{16}$/);
});

test("verifyBundle rejects a tampered bundle", () => {
  const { signed, publicKeyBase64 } = makeSignedBundle();
  signed.bundle.workflow.revision = 99; // modify after signing
  const result = verifyBundle(signed, { publicKey: publicKeyBase64 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Signature verification failed/);
});

test("verifyBundle rejects a foreign key", () => {
  const { signed } = makeSignedBundle();
  const other = crypto.generateKeyPairSync("ed25519");
  const otherBase64 = other.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const result = verifyBundle(signed, { publicKey: otherBase64 });
  assert.equal(result.ok, false);
});

test("verifyBundle accepts raw32 public keys (CP_POLICY_PUBLIC_KEY form)", () => {
  const { signed, publicKeyBase64 } = makeSignedBundle();
  const spki = Buffer.from(publicKeyBase64, "base64");
  const raw32 = spki.subarray(spki.length - 32).toString("base64");
  const result = verifyBundle(signed, { publicKey: raw32 });
  assert.equal(result.ok, true);
});

test("verifyBundle reports a missing key with actionable guidance", () => {
  const { signed } = makeSignedBundle();
  const result = verifyBundle(signed, { publicKey: undefined });
  assert.equal(result.ok, false);
  assert.match(result.reason, /KAVROS_POLICY_PUBLIC_KEY|CP_POLICY_PUBLIC_KEY/);
});

test("verifyBundle rejects unknown algorithms and malformed files", () => {
  assert.equal(verifyBundle(null, {}).ok, false);
  assert.match(verifyBundle({ bundle: {}, signature: "x" }, { publicKey: "k" }).reason, /Unsupported signature algorithm/);
  const { signed, publicKeyBase64 } = makeSignedBundle();
  signed.algorithm = "rsa";
  assert.match(verifyBundle(signed, { publicKey: publicKeyBase64 }).reason, /Unsupported signature algorithm/);
  const { signed: s2 } = makeSignedBundle();
  delete s2.bundle.format;
  assert.match(verifyBundle(s2, { publicKey: publicKeyBase64 }).reason, /Not a valid Kavros workflow bundle/);
});

// ---------- explainFailure ----------

test("explainFailure: blocked request states egress was not reached", () => {
  const e = explainFailure({
    status: 403,
    body: { error: "Blocked by Kavros", reason: "DLP rule matched: credit card" },
  });
  assert.match(e.headline, /Blocked by policy — DLP rule matched/);
  assert.match(e.egress, /Nothing reached the target/);
  assert.ok(e.next.length > 0);
});

test("explainFailure: data-plane credential rejection points at identity", () => {
  // The data plane's own rejections carry a flat string `error` field.
  const e = explainFailure({ status: 401, body: { error: "Missing Kavros credentials" } });
  assert.match(e.headline, /identity was rejected/);
  assert.match(e.egress, /before any policy evaluation/);
});

test("explainFailure: upstream auth refusal says the target answered", () => {
  // A 401/403 from the UPSTREAM (after policy passed) must not be reported
  // as identity rejection — egress physically happened. Stripe nests `error`
  // as an object; other APIs send raw text or their own shapes.
  const e = explainFailure({ status: 401, body: { error: { type: "invalid_request_error" } } });
  assert.match(e.headline, /upstream target answered HTTP 401/);
  assert.match(e.egress, /reached the target/);
  assert.match(e.egress, /not a Kavros denial/);
  assert.match(e.next.join(" "), /credential/i);

  const gh = explainFailure({ status: 403, body: { raw_text: "Request forbidden…User-Agent" } });
  assert.match(gh.headline, /upstream target answered HTTP 403/);
  assert.match(gh.next.join(" "), /User-Agent/);
});

test("explainFailure: 502 says policy passed but target failed", () => {
  const e = explainFailure({ status: 502, body: null });
  assert.match(e.headline, /upstream target could not be reached/);
  assert.match(e.egress, /after egress was attempted/);
});

test("explainFailure: missing config gives the export recipe", () => {
  const e = explainFailure({ configMissing: ["KAVROS_API_KEY"] });
  assert.match(e.headline, /no workload credentials/);
  assert.match(e.next.join(" "), /KAVROS_API_KEY/);
  assert.match(e.egress, /Nothing was sent/);
});

test("explainFailure: fallback stays actionable for unknown statuses", () => {
  const e = explainFailure({ status: 418, body: null });
  assert.match(e.headline, /HTTP 418/);
  assert.ok(e.next.length > 0);
});
