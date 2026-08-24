# @enclavia-os/cli

Language-agnostic developer CLI for Enclavia workload egress.

## Requirements

- Node.js 18 or newer
- A registered Enclavia workload
- Network access to the workload's data-plane endpoint

## Install

```bash
npm install --global @enclavia-os/cli
```

Or run it without a global install:

```bash
npx @enclavia-os/cli doctor
```

## Configure

```bash
export ENCLAVIA_API_URL="https://<data-plane-host>/api/agent/egress"
export ENCLAVIA_API_KEY="<workload-api-key>"
export ENCLAVIA_AGENT_ID="<workload-id>"
```

## Commands

Check connectivity and workload configuration:

```bash
enclavia doctor
```

Send a policy-bound request:

```bash
enclavia request \
  --action post_data \
  --target "https://api.example.com/v1/run" \
  --content '{"input":"hello"}' \
  --header 'content-type:application/json' \
  --json
```

Fetch an approved URL:

```bash
enclavia request --action get --target "https://docs.example.com" --json
```

The CLI sends credentials as headers and supports the same JSON contract used by
native clients. It is useful for smoke tests, scripts, jobs, and applications
that do not yet have a native Enclavia SDK.

Forwarded headers are evaluated against the workload policy like any other
request content; the CLI warns when a header looks like credentials
(`Authorization`, `Cookie`, or `x-enclavia-*`).

## Development

```bash
npm test
node bin/enclavia.mjs --help
```

The CLI has no runtime dependencies and supports Node.js 18 and newer. The
printed version is read from `package.json` at runtime.

## Releasing

Releases use npm Trusted Publishing (GitHub Actions OIDC) — no stored npm
token, and every published package carries a sigstore provenance attestation.

One-time setup on npmjs.com under the package's **Settings → Trusted
Publisher**:

- Provider: GitHub Actions
- Organization or user: `Enclavia-OS`
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
token with publish permission for `@enclavia-os/cli` and **bypass 2FA** enabled
as the `NPM_TOKEN` Actions secret. The workflow then publishes without
provenance (`EOTP` failures in Actions mean 2FA bypass was not enabled).
Provenance requires a public source repository, so Trusted Publishing is the
long-term path. Remove the `NPM_TOKEN` secret once a tagged release has
published through OIDC.

npm does not allow re-publishing an existing package version; if a tag was
already published successfully, bump the version instead of retrying.

## License

[MIT](LICENSE)
