// Signed workflow-bundle verification for the Kavros CLI. Pure functions,
// no dependencies beyond Node's crypto — mirrors the control plane's
// lib/workflowBundle.ts (canonical JSON + Ed25519 over the canonical bytes)
// so "trust us" becomes "run kavros verify-bundle" locally, including on
// machines that never talk to a deployment.

import crypto from "node:crypto";

const BUNDLE_FORMAT = "kavros-workflow-bundle";
const BUNDLE_FORMAT_VERSION = 2;

/** Deterministic JSON with recursively sorted keys — byte-identical to the
 * control plane's canonical form, which is what the signature covers. */
export function canonicalJson(value) {
  const seen = new WeakSet();
  const walk = (node) => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);
    if (seen.has(node)) throw new Error("Cannot canonicalize a bundle with reference cycles.");
    seen.add(node);
    const out = {};
    for (const key of Object.keys(node).sort()) {
      out[key] = walk(node[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * Verify a signed bundle against a trusted public key.
 *
 * @param {object} signed  Parsed bundle file: { bundle, signature, algorithm? }
 * @param {object} options
 * @param {string} [options.publicKey]  Base64 SPKI DER or raw32 Ed25519 key
 *   (the CP_POLICY_PUBLIC_KEY value provisioning shares between deployments).
 *   Falls back to KAVROS_POLICY_PUBLIC_KEY / CP_POLICY_PUBLIC_KEY env vars.
 * @param {string} [options.expectedWorkflow]  When set, fails if the bundle is
 *   for a different workflow name (guards against swapping files).
 * @returns {{ ok: boolean, reason?: string, summary?: object }}
 */
export function verifyBundle(signed, options = {}) {
  if (!signed || typeof signed !== "object") {
    return { ok: false, reason: "Not a signed bundle file — expected a JSON object." };
  }
  if (signed.algorithm !== "ed25519") {
    return {
      ok: false,
      reason: `Unsupported signature algorithm: ${signed.algorithm ?? "none"}. Kavros bundles are Ed25519-signed; this file may not be a bundle export.`,
    };
  }
  const publicKeyBase64 = options.publicKey ?? process.env.KAVROS_POLICY_PUBLIC_KEY ?? process.env.CP_POLICY_PUBLIC_KEY;
  if (!publicKeyBase64) {
    return {
      ok: false,
      reason: "No trusted public key supplied. Pass --public-key <base64> or set KAVROS_POLICY_PUBLIC_KEY (the CP_POLICY_PUBLIC_KEY value from provisioning).",
    };
  }
  const bundle = signed.bundle;
  if (
    !bundle ||
    typeof bundle !== "object" ||
    bundle.format !== BUNDLE_FORMAT ||
    bundle.format_version !== BUNDLE_FORMAT_VERSION ||
    !bundle.workflow ||
    typeof bundle.workflow.name !== "string"
  ) {
    return { ok: false, reason: "Not a valid Kavros workflow bundle (missing format markers or workflow name)." };
  }
  if (typeof signed.signature !== "string" || signed.signature.length === 0) {
    return { ok: false, reason: "The bundle file has no signature." };
  }

  let publicKey;
  try {
    const der = Buffer.from(publicKeyBase64, "base64");
    try {
      publicKey = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    } catch {
      if (der.length !== 32) {
        return { ok: false, reason: `The supplied public key is neither SPKI DER nor raw32 Ed25519 (${der.length} bytes).` };
      }
      publicKey = crypto.createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: der.toString("base64url") },
        format: "jwk",
      });
    }
  } catch {
    return { ok: false, reason: "The supplied public key could not be parsed." };
  }

  let canonical;
  try {
    canonical = canonicalJson(bundle);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Unserializable bundle." };
  }

  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(canonical, "utf8"), publicKey, Buffer.from(signed.signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      ok: false,
      reason: "Signature verification failed — the bundle was modified after signing or was signed by a different deployment.",
    };
  }

  if (options.expectedWorkflow && bundle.workflow.name !== options.expectedWorkflow) {
    return {
      ok: false,
      reason: `Signature is valid, but this bundle is for workflow "${bundle.workflow.name}", not "${options.expectedWorkflow}".`,
    };
  }

  const capabilities = Array.isArray(bundle.capabilities) ? bundle.capabilities : [];
  return {
    ok: true,
    summary: {
      workflow: bundle.workflow.name,
      revision: bundle.workflow.revision,
      exported_at: bundle.exported_at,
      origin_deployment: bundle.origin?.deployment_id ?? null,
      capabilities: capabilities.map((c) => ({
        key: c.key,
        version: c.version,
        source: c.source,
        approved_columns: Array.isArray(c.approved_columns) ? c.approved_columns.length : 0,
      })),
      signature_key_fingerprint: fingerprint(publicKey),
    },
  };
}

/** Short SHA-256 fingerprint of the verifying public key, for audit notes. */
export function fingerprint(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return `sha256:${crypto.createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}
