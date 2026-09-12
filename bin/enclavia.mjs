#!/usr/bin/env node

import process from "node:process";
import { readFileSync } from "node:fs";
import {
  config,
  parseArgs,
  parseContent,
  parseHeaders,
  requireConfig,
  sensitiveHeaders,
} from "../lib/args.mjs";
import { verifyBundle } from "../lib/bundle.mjs";
import { explainFailure } from "../lib/explain.mjs";
import { readFile } from "node:fs/promises";

const { version: VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function usage() {
  console.log(`Enclavia CLI ${VERSION}

Language-agnostic tools for protected workload egress.

Usage:
  enclavia request --action <action> --target <url> [--content <json|string>]
  enclavia doctor
  enclavia verify-bundle <file> [--public-key <base64>]
  enclavia explain <http-status> [--body <json>]
  enclavia help <command>
  enclavia --version
  enclavia --help

Commands:
  request        Send a policy-bound request through the data plane
  doctor         Check connectivity and workload configuration
  verify-bundle  Verify a signed workflow bundle's Ed25519 signature locally
  explain        Plain-language meaning of a governed-request failure

Environment:
  ENCLAVIA_API_URL             Data-plane egress URL
  ENCLAVIA_API_KEY             Workload API key
  ENCLAVIA_AGENT_ID            Workload ID
  ENCLAVIA_POLICY_PUBLIC_KEY   Trusted public key for verify-bundle (optional)

Run 'enclavia help <command>' for command-specific options and examples.

Examples:
  enclavia doctor
  enclavia request --action post_data --target https://api.example.com/v1/run \\
    --content '{"input":"hello"}'
  enclavia verify-bundle workflow.enclavia-bundle.json
`);
}

function commandHelp(command) {
  const pages = {
    request: `enclavia request — send a policy-bound request through the data plane

The request is evaluated against the workload's signed policy: identity,
allowlist, DLP, and metering. A block is a governed outcome, not an error —
use \`enclavia explain\` or the failure footer for what to do next.

Required:
  --action <action>     e.g. get or post_data (per the workload's policy)
  --target <url>        the approved upstream URL

Options:
  --content <json|string>   request body
  --header <name:value>     forward a header (repeatable; credential-like
                            headers warn)
  --json                    formatted JSON output
  --timeout <seconds>       request timeout (default: 120)

Environment: ENCLAVIA_API_URL, ENCLAVIA_API_KEY, ENCLAVIA_AGENT_ID

Examples:
  enclavia request --action get --target https://docs.example.com --json
  enclavia request --action post_data --target https://api.example.com/v1/run \\
    --content '{"input":"hello"}'
`,
    doctor: `enclavia doctor — check connectivity and workload configuration

Verifies that the data plane is reachable and the configured workload
identity is accepted. Requires the same environment as request.

Environment: ENCLAVIA_API_URL, ENCLAVIA_API_KEY, ENCLAVIA_AGENT_ID

Example:
  enclavia doctor
`,
    "verify-bundle": `enclavia verify-bundle — verify a signed workflow bundle locally

Checks the Ed25519 signature on a bundle exported from a control plane
against a trusted public key. This is the same verification the import
route performs, run on your machine — useful before importing a bundle
and for security review. Works offline; no deployment connection needed.

Usage:
  enclavia verify-bundle <file> [--public-key <base64>]

Options:
  --public-key <base64>  Trusted public key (SPKI DER or raw32 base64).
                         Falls back to ENCLAVIA_POLICY_PUBLIC_KEY, then
                         CP_POLICY_PUBLIC_KEY.
  --json                 Print the verification result as JSON

The key to trust is the CP_POLICY_PUBLIC_KEY value provisioning shares
between the exporting and importing deployments.

Examples:
  enclavia verify-bundle workflow.enclavia-bundle.json
  enclavia verify-bundle bundle.json --public-key "MCowBQYDK2VwAyEA…"
`,
    explain: `enclavia explain — plain-language meaning of a governed failure

Turns a data-plane status/body into what happened, whether egress was
reached, and what to do next. Also prints automatically when a request
fails (unless --json is set).

Usage:
  enclavia explain <http-status> [--body '<json>']

Examples:
  enclavia explain 403 --body '{"error":"Blocked by Enclavia","reason":"DLP rule matched"}'
  enclavia explain 429
`,
  };
  const page = pages[command];
  if (!page) {
    console.error(`enclavia: no help for "${command}". Commands: request, doctor, verify-bundle, explain.`);
    process.exitCode = 2;
    return;
  }
  console.log(page);
}

function fail(message, code = 2) {
  console.error(`enclavia: ${message}`);
  process.exitCode = code;
}

async function fetchWithTimeout(url, init, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function printBody(body, formatted) {
  if (typeof body === "string") console.log(body);
  else console.log(JSON.stringify(body ?? {}, null, formatted ? 2 : 0));
}

async function request(options) {
  const values = requireConfig();
  if (!options.action) throw new Error("request requires --action");
  if (!options.target) throw new Error("request requires --target");

  const upstreamHeaders = parseHeaders(options.headers);
  for (const name of sensitiveHeaders(upstreamHeaders)) {
    console.error(`enclavia: warning: forwarding sensitive header "${name}" to the upstream target; omit it unless the target requires it`);
  }
  const headers = {
    Authorization: `Bearer ${values.apiKey}`,
    "X-Enclavia-Agent-ID": values.agentId,
    "Content-Type": "application/json",
  };
  const payload = {
    action: options.action,
    target: options.target,
    content: parseContent(options.content),
    headers: upstreamHeaders,
  };
  const timeoutSeconds = Number(options.timeout ?? 120);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number");

  let response;
  try {
    response = await fetchWithTimeout(values.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, timeoutSeconds);
  } catch (error) {
    throw new Error(`data-plane request failed: ${error.name === "AbortError" ? "timed out" : error.message}`);
  }

  const body = await readBody(response);
  if (!response.ok) {
    printBody(body, true);
    if (!options.json) {
      const explanation = explainFailure({ status: response.status, body });
      console.error(`\nWhat happened: ${explanation.headline}`);
      console.error(`Egress: ${explanation.egress}`);
      console.error("Next steps:");
      for (const step of explanation.next) console.error(`  - ${step}`);
    }
    process.exitCode = 1;
    return;
  }
  printBody(body, options.json);
}

async function verifyBundleCommand(options) {
  const file = options._[1];
  if (!file) throw new Error("verify-bundle requires a bundle file path");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`cannot read bundle file: ${file}`);
  }
  let signed;
  try {
    signed = JSON.parse(raw);
  } catch {
    throw new Error("the bundle file is not valid JSON");
  }
  const publicKeyBase64 = options["public-key"];
  const result = verifyBundle(signed, { publicKey: publicKeyBase64 });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    const s = result.summary;
    console.log(`Signature valid (Ed25519, key ${s.signature_key_fingerprint}).`);
    console.log(`Workflow: ${s.workflow} (revision ${s.revision ?? "?"})`);
    console.log(`Exported: ${s.exported_at ?? "unknown"}${s.origin_deployment ? ` from deployment ${s.origin_deployment}` : ""}`);
    if (s.capabilities.length === 0) {
      console.log("Capabilities: none");
    } else {
      console.log("Capabilities:");
      for (const c of s.capabilities) {
        const columns = c.approved_columns > 0 ? `, ${c.approved_columns} approved column(s)` : "";
        console.log(`  - ${c.key} v${c.version ?? "?"}${c.source ? ` (${c.source}${columns})` : ""}`);
      }
    }
    console.log("Safe to import: the bundle matches the deployment key you trust.");
  } else {
    console.error(`Signature verification FAILED: ${result.reason}`);
    console.error("Do not import this bundle. Re-export from the source deployment or confirm the trusted key with the sender.");
    process.exitCode = 1;
  }
}

function explainCommand(options) {
  const status = Number(options._[1]);
  if (!Number.isInteger(status) || status < 100) throw new Error("explain requires an HTTP status, e.g. enclavia explain 403");
  let body;
  if (options.body) {
    try {
      body = JSON.parse(options.body);
    } catch {
      body = options.body;
    }
  }
  const explanation = explainFailure({ status, body });
  console.log(`What happened: ${explanation.headline}`);
  console.log(`Egress: ${explanation.egress}`);
  console.log("Next steps:");
  for (const step of explanation.next) console.log(`  - ${step}`);
}

async function doctor() {
  const values = config();
  const missing = [];
  if (!values.url) missing.push("ENCLAVIA_API_URL");
  if (!values.apiKey) missing.push("ENCLAVIA_API_KEY");
  if (!values.agentId) missing.push("ENCLAVIA_AGENT_ID");
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  let response;
  try {
    const healthUrl = new URL(values.url);
    healthUrl.pathname = "/health";
    healthUrl.search = "";
    response = await fetchWithTimeout(healthUrl, {
      headers: {
        Authorization: `Bearer ${values.apiKey}`,
        "X-Enclavia-Agent-ID": values.agentId,
      },
    }, 10);
  } catch (error) {
    console.error(`Data plane unreachable: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const body = await readBody(response);
  if (!response.ok) {
    console.error(`Data plane health check failed (HTTP ${response.status})`);
    printBody(body, true);
    process.exitCode = 1;
    return;
  }
  console.log(`Data plane reachable${body?.build_sha ? ` (build ${body.build_sha})` : ""}.`);
  console.log(`Workload identity configured: ${values.agentId}`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.version) {
      console.log(VERSION);
      return;
    }
    if (options.help || options._[0] === undefined) {
      usage();
      return;
    }
    const [command] = options._;
    if (options.help && command && command !== "help") {
      commandHelp(command);
      return;
    }
    if (command === "request") await request(options);
    else if (command === "doctor") await doctor();
    else if (command === "verify-bundle") await verifyBundleCommand(options);
    else if (command === "explain") explainCommand(options);
    else if (command === "help" && options._[1]) commandHelp(options._[1]);
    else throw new Error(`unknown command ${command ?? ""}; run enclavia --help`);
  } catch (error) {
    fail(error.message);
  }
}

await main();
