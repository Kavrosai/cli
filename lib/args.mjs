// Pure argument and configuration helpers for the Kavros CLI. Kept free of
// I/O so the test suite can exercise them without network or environment setup.

export function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) {
      options._.push(value);
      continue;
    }
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--version" || value === "-v") options.version = true;
    else if (value === "--json") options.json = true;
    else if (value === "--action" || value === "--target" || value === "--content" || value === "--header" || value === "--timeout" || value === "--public-key" || value === "--body") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`${value} requires a value`);
      index += 1;
      if (value === "--header") {
        options.headers ??= [];
        options.headers.push(next);
      } else {
        options[value.slice(2)] = next;
      }
    } else {
      throw new Error(`unknown option: ${value}`);
    }
  }
  return options;
}

export function config() {
  return {
    url: process.env.KAVROS_API_URL,
    apiKey: process.env.KAVROS_API_KEY,
    agentId: process.env.KAVROS_AGENT_ID,
  };
}

export function requireConfig(values = config()) {
  const missing = missingConfig(values);
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(", ")}; configure the workload environment first`);
  }
  return values;
}

/** Environment names that are unset, in config order — for the explain path. */
export function missingConfig(values = config()) {
  return Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key === "url" ? "KAVROS_API_URL" : key === "apiKey" ? "KAVROS_API_KEY" : "KAVROS_AGENT_ID");
}

export function parseHeaders(values = []) {
  const headers = {};
  for (const value of values) {
    const separator = value.indexOf(":");
    if (separator < 1) throw new Error(`invalid --header value ${JSON.stringify(value)}; use name:value`);
    headers[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
  }
  return headers;
}

export function parseContent(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

// Headers that should never be blindly forwarded to the upstream target:
// workload credentials (x-kavros-*), end-user credentials, and the Host
// header, which the upstream connection must derive itself.
const SENSITIVE_HEADER_NAMES = new Set(["authorization", "cookie", "host"]);

export function sensitiveHeaders(headers) {
  return Object.keys(headers).filter((name) => {
    const lower = name.toLowerCase();
    return SENSITIVE_HEADER_NAMES.has(lower) || lower.startsWith("x-kavros-");
  });
}
