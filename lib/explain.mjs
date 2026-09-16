// Plain-language error explanation for CLI failures — the plan's rule that a
// failure sentence must say what happened, whether egress was reached, and
// what to do next. Pure: maps known API/error payloads to human guidance.

/**
 * Build an operator-readable explanation for a failed governed request.
 *
 * @param {object} params
 * @param {number} [params.status]          HTTP status of the data-plane reply
 * @param {object|string|null} [params.body] Parsed response body (or text)
 * @param {string[]} [params.configMissing] Missing env var names, if config failed
 * @returns {{ headline: string, egress: string, next: string[] }}
 */
export function explainFailure({ status, body, configMissing = [] } = {}) {
  if (configMissing.length > 0) {
    return {
      headline: "This shell has no workload credentials configured.",
      egress: "Nothing was sent — no egress was attempted.",
      next: [
        "Export the three variables from your workload's provisioning page:",
        "  export KAVROS_API_URL=\"https://<data-plane-host>/api/agent/egress\"",
        "  export KAVROS_API_KEY=\"<workload-api-key>\"",
        "  export KAVROS_AGENT_ID=\"<workload-id>\"",
        "Then run `kavros doctor` to confirm connectivity.",
      ],
    };
  }

  const reason =
    typeof body === "object" && body !== null
      ? body.reason ?? body.error ?? null
      : typeof body === "string" && body
        ? body
        : null;
  const blocked = typeof body === "object" && body !== null && body.error === "Blocked by Kavros";

  if (blocked) {
    return {
      headline: `Blocked by policy${reason ? ` — ${reason}` : "."}`,
      egress: "The request was stopped at the data plane. Nothing reached the target, and blocked content is never forwarded or stored.",
      next: [
        "Read the reason above: it names the violated rule (DLP match, unapproved target, or identity state).",
        "If the target is legitimate, ask your admin to add it to the workload's signed policy — do not bypass the data plane.",
        "Run `kavros doctor` to rule out an identity problem (halted or revoked workloads also block).",
      ],
    };
  }

  if (status === 401 || status === 403) {
    return {
      headline: "Your workload identity was rejected.",
      egress: "The data plane refused the credentials before any policy evaluation — nothing was sent onward.",
      next: [
        "Check that KAVROS_API_KEY and KAVROS_AGENT_ID belong to the same registered workload.",
        "The workload may be halted or revoked — an admin can check its state in the Agent Registry.",
        "If the key was rotated, fetch the current key from the control plane and re-export it.",
      ],
    };
  }

  if (status === 404) {
    return {
      headline: "The data plane does not recognize this workload or route.",
      egress: "Nothing was forwarded — the request stopped at the data plane.",
      next: [
        "Confirm KAVROS_API_URL points at the data-plane egress endpoint (…/api/agent/egress), not the control plane UI.",
        "Confirm KAVROS_AGENT_ID matches a workload registered on this deployment.",
      ],
    };
  }

  if (status === 429) {
    return {
      headline: "Rate or quota limit reached.",
      egress: "The request was refused at the data plane; nothing was sent onward.",
      next: [
        "Wait for the current window to reset, or ask your admin to raise the workload's quota.",
        "Repeated 429s are visible in Usage — an admin can identify which workload is consuming the budget.",
      ],
    };
  }

  if (status === 502 || status === 504) {
    return {
      headline: "The approved upstream target could not be reached.",
      egress: "Policy checks passed, but the target itself failed or timed out after egress was attempted.",
      next: [
        "This is a target-side failure, not a policy denial — retry or check the target service's health.",
        "If it persists, verify the target URL in the workload's policy matches a healthy endpoint.",
      ],
    };
  }

  if (status === 500 || status === 503) {
    return {
      headline: "The data plane reported an internal error.",
      egress: "The request failed inside the data plane; depending on the stage, egress may not have been attempted.",
      next: [
        "Retry once, then check the deployment's health page or contact the operator.",
        "Include the request timestamp in any report — data-plane logs are audit-linked.",
      ],
    };
  }

  if (status !== undefined) {
    return {
      headline: `The data plane returned HTTP ${status}.`,
      egress: status >= 500 ? "A server-side failure occurred." : "The request was refused before egress.",
      next: ["Run `kavros doctor` to verify connectivity and identity, then retry."],
    };
  }

  return {
    headline: reason ? `Request failed — ${reason}` : "Request failed.",
    egress: "The failure occurred before a verdict was reached; treat the target as unreached.",
    next: ["Run `kavros doctor` to verify connectivity and identity, then retry."],
  };
}

/** One-line summary for scripts/CI: headline only, no advice. */
export function explainOneLine(explanation) {
  return explanation.headline;
}
