# @kavrosai/cli

Language-agnostic developer CLI for Kavros workload egress.

## Requirements

- Node.js 18 or newer
- A registered Kavros workload
- Network access to the workload's data-plane endpoint

## Install

```bash
npm install --global @kavrosai/cli
```

Or run it without a global install:

```bash
npx @kavrosai/cli doctor
```

## Configure

```bash
export KAVROS_API_URL="https://<data-plane-host>/api/agent/egress"
export KAVROS_API_KEY="<workload-api-key>"
export KAVROS_AGENT_ID="<workload-id>"
```

## Commands

Check connectivity and workload configuration:

```bash
kavros doctor
```

Per-command options and examples:

```bash
kavros help <command>
```

Send a policy-bound request:

```bash
kavros request \
  --action post_data \
  --target "https://api.example.com/v1/run" \
  --content '{"input":"hello"}' \
  --header 'content-type:application/json' \
  --json
```

Fetch an approved URL:

```bash
kavros request --action get --target "https://docs.example.com" --json
```

The CLI sends credentials as headers and supports the same JSON contract used by
native clients. It is useful for smoke tests, scripts, jobs, and applications
that do not yet have a native Kavros SDK.

Forwarded headers are evaluated against the workload policy like any other
request content; the CLI warns when a header looks like credentials
(`Authorization`, `Cookie`, or `x-kavros-*`).

### When a request is blocked

A block is a governed outcome, not a malfunction. The CLI prints the policy
reason plus a plain-language explanation: what happened, whether the content
reached the outside world (blocked requests never do), and what to do next.
The same explanation is available standalone:

```bash
kavros explain 403 --body '{"error":"Blocked by Kavros","reason":"…"}'
```

### Verify a signed workflow bundle locally

Before importing a workflow bundle exported from another deployment, verify its
Ed25519 signature against the trusted public key (`CP_POLICY_PUBLIC_KEY` from
provisioning) — the same check the import route performs, run on your machine,
often offline:

```bash
kavros verify-bundle workflow.kavros-bundle.json \
  --public-key "$CP_POLICY_PUBLIC_KEY"
```

The key defaults to `KAVROS_POLICY_PUBLIC_KEY`, then `CP_POLICY_PUBLIC_KEY`,
from the environment. Output names the workflow, revision, origin deployment,
pinned capabilities, and a fingerprint of the key that verified the signature —
suitable for pasting into a change record. A tampered or foreign-signed bundle
exits non-zero with instructions not to import.

## Development

```bash
npm test
node bin/kavros.mjs --help
```

The CLI has no runtime dependencies and supports Node.js 18 and newer. The
printed version is read from `package.json` at runtime.

## Releasing

Releases use npm Trusted Publishing (GitHub Actions OIDC) — no stored npm
token, and every published package carries a sigstore provenance attestation.

One-time setup on npmjs.com under the package's **Settings → Trusted
Publisher**:

- Provider: GitHub Actions
- Organization or user: `Kavrosai`
- Repository: `cli`
- Workflow filename: `publish.yml`
- Allowed action: npm publish

To release a new version, update `version` in `package.json`, commit, then push
a matching tag — the workflow rejects a tag that does not match:

```bash
git tag v0.2.3
git push origin v0.2.3
```

Fallback until Trusted Publishing is configured: add an npm granular access
token with publish permission for `@kavrosai/cli` and **bypass 2FA** enabled
as the `NPM_TOKEN` Actions secret. The workflow then publishes without
provenance (`EOTP` failures in Actions mean 2FA bypass was not enabled).
Provenance requires a public source repository, so Trusted Publishing is the
long-term path. Remove the `NPM_TOKEN` secret once a tagged release has
published through OIDC.

npm does not allow re-publishing an existing package version; if a tag was
already published successfully, bump the version instead of retrying.

## License

[MIT](LICENSE)
