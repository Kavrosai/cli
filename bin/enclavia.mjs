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

const { version: VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function usage() {
  console.log(`Enclavia CLI ${VERSION}

Language-agnostic tools for protected workload egress.

Usage:
  enclavia request --action <action> --target <url> [--content <json|string>]
  enclavia doctor
  enclavia --version
  enclavia --help

Environment:
  ENCLAVIA_API_URL    Data-plane egress URL
  ENCLAVIA_API_KEY    Workload API key
  ENCLAVIA_AGENT_ID   Workload ID

Options:
  --header <name:value>  Forward a header to the approved upstream target
  --json                 Print the response as formatted JSON
  --timeout <seconds>   Request timeout (default: 120)

Examples:
  enclavia doctor
  enclavia request --action post_data --target https://api.example.com/v1/run \\
    --content '{"input":"hello"}'
  enclavia request --action get --target https://docs.example.com
`);
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
    process.exitCode = 1;
    return;
  }
  printBody(body, options.json);
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
    if (command === "request") await request(options);
    else if (command === "doctor") await doctor();
    else throw new Error(`unknown command ${command}`);
  } catch (error) {
    fail(error.message);
  }
}

await main();
