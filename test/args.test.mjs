import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  parseContent,
  parseHeaders,
  requireConfig,
  sensitiveHeaders,
} from "../lib/args.mjs";

test("parseArgs collects positionals and flags", () => {
  const options = parseArgs(["request", "--json", "--action", "get", "--target", "https://example.com"]);
  assert.deepEqual(options._, ["request"]);
  assert.equal(options.json, true);
  assert.equal(options.action, "get");
  assert.equal(options.target, "https://example.com");
});

test("parseArgs accepts short flags", () => {
  const options = parseArgs(["-h", "-v"]);
  assert.equal(options.help, true);
  assert.equal(options.version, true);
});

test("parseArgs supports repeated --header values", () => {
  const options = parseArgs(["--header", "a:1", "--header", "b:2"]);
  assert.deepEqual(options.headers, ["a:1", "b:2"]);
});

test("parseArgs rejects options without values", () => {
  assert.throws(() => parseArgs(["--target"]), /--target requires a value/);
});

test("parseArgs rejects unknown options", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unknown option: --bogus/);
});

test("parseHeaders splits on the first colon and trims", () => {
  const headers = parseHeaders(["content-type: application/json", "x-trace:id:9"]);
  assert.deepEqual(headers, { "content-type": "application/json", "x-trace": "id:9" });
});

test("parseHeaders rejects malformed values", () => {
  assert.throws(() => parseHeaders(["no-separator"]), /invalid --header value/);
  assert.throws(() => parseHeaders([":value"]), /invalid --header value/);
});

test("parseContent normalizes JSON and passes raw strings through", () => {
  assert.equal(parseContent(undefined), "");
  assert.equal(parseContent('{"b":1,"a":2}'), '{"b":1,"a":2}');
  assert.equal(parseContent("plain text"), "plain text");
});

test("requireConfig reports missing variables by environment name", () => {
  assert.deepEqual(
    requireConfig({ url: "https://dp.example.com", apiKey: "k", agentId: "a" }),
    { url: "https://dp.example.com", apiKey: "k", agentId: "a" },
  );
  assert.throws(
    () => requireConfig({ url: "https://dp.example.com", apiKey: "", agentId: undefined }),
    /missing ENCLAVIA_API_KEY, ENCLAVIA_AGENT_ID/,
  );
});

test("sensitiveHeaders flags workload and end-user credentials", () => {
  assert.deepEqual(
    sensitiveHeaders({ Authorization: "x", "X-Enclavia-Agent-ID": "y", Cookie: "z" }),
    ["Authorization", "X-Enclavia-Agent-ID", "Cookie"],
  );
  assert.deepEqual(sensitiveHeaders({ "content-type": "application/json" }), []);
});
