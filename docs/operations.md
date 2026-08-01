# Argus operations

## Choosing a topology

Use SQLite with `runtime.role: all` for one VPS. It has the fewest moving
parts and remains the recommended starting point.

Use PostgreSQL for multiple services. Run one or more API and worker replicas,
one scheduler, and an optional processor. Set `ARGUS_ROLE` per service; it
overrides the role in the shared YAML file. Jobs use expiring database leases,
so worker crashes are retried without Redis or Kafka.

## Source setup

### X

Deploy the upstream FxEmbed Worker into a Cloudflare account you control.
Configure its X credentials according to that project, then set
`sources.x.endpoint` to the API realm, for example
`https://api.fx.example.com` or `http://localhost:8787/api` during local
development. Argus calls the profile-status and search endpoints.

### Telegram

Provide public channel usernames without `@`. Argus polls Telegram's public
preview (`t.me/s/<channel>`) anonymously. The channel must expose a public
preview. V1 intentionally has no bot token, user session, group-chat access,
or private-channel support.

### Web

URL targets are fetched and reduced to readable title/text. Feed targets accept
RSS and Atom. Query targets require a SearXNG base URL with JSON output enabled.
Argus respects ordinary HTTP failures and does not bypass authentication,
CAPTCHA, robots policy, or network controls.

## Secrets

Put secret references such as `${ARGUS_API_TOKEN}` in YAML and the values in
the process environment. Required values:

- `ARGUS_API_TOKEN` when API authentication is configured
- `OPENROUTER_API_KEY` only when intelligence is enabled
- database credentials when PostgreSQL is used

Applied configuration snapshots remove API and OpenRouter secrets. Logs do not
print configuration objects or authorization headers.

## Backup and recovery

For SQLite, stop Argus and copy the database plus any `-wal` and `-shm` files,
or use SQLite's online backup tooling. Restore all files together.

For PostgreSQL, use regular `pg_dump`/`pg_restore` or provider snapshots.
Records and revisions are immutable history; current records can be rebuilt
from revisions if necessary. After restore, restart the scheduler and workers.
Idempotent identities prevent unchanged source items from duplicating.

## Health and querying

`GET /health` reports process health and does not require a token. All `/v1`
routes use bearer authentication when `api.token` is configured.

Record query parameters:

- `q`: full-text query
- repeated `source`: `x`, `telegram`, or `web`
- repeated `target`: canonical target ID
- `since` / `until`: ISO timestamps
- `limit`: 1–200
- `cursor`: opaque cursor returned by the prior page

`POST /v1/watches/:watchId/ingest` queues an immediate run of every target in a
watch. `GET /v1/artifacts` returns stored intelligence outputs without mixing
them into canonical source records.

## Updating configuration

Validate and apply before restarting:

```bash
pnpm argus config validate /app/argus.yaml
pnpm argus config apply /app/argus.yaml
```

Invalid files never replace the current snapshot. Reapplying identical content
is a no-op. Runtime services should all mount the same config revision.

## Installer smoke

`.github/workflows/installer-smoke.yml` runs automatically after the signed
release workflow completes successfully and can be started manually with an
immutable release tag. It uses digest-pinned Ubuntu and Debian root filesystems
on fixed native amd64 and arm64 runners. Separate jobs cover a usable existing
Docker installation and the installer's explicit `ARGUS_INSTALL_DOCKER=1` path
on a systemd clean host.

The smoke first runs the installer's mutation-free inspection and compares
exact, allowlisted before/after state. The snapshot covers the complete install
root and wrapper metadata/content, apt sources and keyrings, package inventory,
installer locks and temp paths, plus Docker binaries, versions, daemon
availability, and service state. It then installs the wrapper twice, verifies
its signed-manifest checksum, byte identity, and version after both installs,
and applies a strict Web-only answers file. Its API token is generated inside
the disposable host and is not a user or repository secret. Success requires
`/opt/argus/state.json` to name the expected release and `argus doctor --json`
to report both `ok: true` and `healthy: true`.

Manual workflow runs resolve the selected tag back to the unique successful
signed-release workflow that published it across every API result page. They
read the explicit Git tag ref and recursively peel annotated tag objects to a
commit, require that commit to equal the workflow SHA, and check out only that
SHA. A moved, cyclic, excessively deep, malformed, or non-commit tag, an
ambiguous run set, a mismatched release, or a failed API/upstream release stops
the workflow without running privileged candidate code.

To run `scripts/e2e/installer-smoke.sh` directly, use an isolated supported
Linux host as root. The script may install Docker and writes `/usr/local/bin/argus`
and `/opt/argus`; do not run it on a workstation or an existing Argus instance.

```bash
tag=v0.1.0
base="https://github.com/gpsxtreme/argus/releases/download/$tag"
curl --fail --location --output /tmp/argus-manifest.json "$base/manifest.json"
version=${tag#v}
wrapper_sha256=$(jq -er '.assets.wrapper.sha256' /tmp/argus-manifest.json)
sudo --preserve-env=PATH \
  ARGUS_INSTALLER_URL="$base/install.sh" \
  ARGUS_MANIFEST_URL="$base/manifest.json" \
  ARGUS_EXPECTED_VERSION="$version" \
  ARGUS_EXPECTED_WRAPPER_SHA256="$wrapper_sha256" \
  ARGUS_INSTALL_DOCKER=0 \
  scripts/e2e/installer-smoke.sh
```

Loopback HTTP is accepted only with `ARGUS_INSTALL_FIXTURE=1`; the matching
installer must still embed the fixture public key, and the manifest signature
and wrapper hash are still verified. The smoke needs outbound HTTPS for the
release, OCI images, and the controlled IANA example Web target. Ubuntu 25.10
is omitted from the recurring matrix because it is end-of-life; the maintained
Ubuntu releases and Debian 12/13 remain covered.

On failure CI uploads only `installer.log`, `wrapper.sha256`, `compose.log`,
and `doctor.json`, each from the dedicated smoke artifact directory. It never
uploads `secrets.env`, signing keys, tokens, private keys, or an environment
dump.
