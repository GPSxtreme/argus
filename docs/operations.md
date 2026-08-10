# Argus operations

## VPS installation and onboarding

Use a fresh Ubuntu 24.04 or Debian 13 host with outbound HTTPS. While the
repository is private, create a GitHub token with read access to Argus and run:

```bash
curl -fsSL https://argus.gpsxtre.me/install.sh |
  ARGUS_GITHUB_TOKEN="<GitHub token with read access>" sh
argus onboard
```

`argus onboard` asks which sources and storage to enable, whether SearXNG and
FxEmbed are managed or external, what to watch, and which schedules to use.
The resulting instance lives in `/opt/argus`:

- `argus.yaml` is the generated application configuration.
- `compose.yaml` is owned and reconciled by the Argus CLI.
- `state.json` records the verified release and deployment state.
- `release-context.json` retains the exact signed release used for rollback.
- `management.state` selects the signed management CLI for the immutable
  `/usr/local/bin/argus` launcher. It is strict data, not a configuration file;
  do not edit it.
- `secrets.env` contains runtime credentials and must remain mode `0600`.
- `backups/` contains update backups. Argus never deletes them automatically.
- `.docker/config.json` stores the mode `0600` GHCR credential while Argus
  images are private. Remove it after the images become public.

Do not hand-edit Compose, state, release context, or managed service settings.
Change the onboarding answers and rerun `argus onboard`, or use the targeted
CLI commands below.

For repeatable automation, store the non-secret answers in a mode `0600` YAML
file and enter required secrets through a TTY:

```bash
argus onboard --from setup.yaml --yes --json
argus status --json
argus doctor --json
```

Every JSON response has `contractVersion`, `ok`, and either `data` or `error`.
Mutation commands in non-interactive JSON automation require `--yes`; a plan
without it does not authorize a mutation.

## Managed and external services

Managed SearXNG runs only on Argus's private Compose network. It enables Web
query watches and is checked with a bounded JSON search. It does not publish
another host port. To use an existing SearXNG, choose `external` and give its
HTTPS endpoint; Argus will not manage or repair that service.

FxEmbed is a Cloudflare Worker rather than a VPS container. Managed mode
deploys the pinned worker bundle to the supplied Cloudflare account. External
mode records an existing endpoint. Disabled mode leaves X ingestion
unavailable while Telegram and Web continue to run.

SQLite is the low-friction single-VPS default. PostgreSQL is available when
the instance needs separate runtime roles or external database operations.

## Lifecycle commands

Human mode shows a plan and asks before changes. Automation can use:

```bash
argus start --json --yes
argus stop --json --yes
argus restart --json --yes
argus status --json
argus logs --tail 200 --json
argus doctor --json
argus repair argus --json --yes
argus repair postgres --json --yes
argus repair searxng --json --yes
argus update --json --yes
argus update --rollback --json --yes
```

`argus update` downloads and verifies the stable signed manifest before it
stops services. It backs up the current instance, runs storage migrations,
starts the candidate, and verifies health. A failed update restores the
previous verified release; keep `/opt/argus/backups` until you have separately
validated the new version.

Existing installations with the legacy version-pinned wrapper need one final
signed installer run to bootstrap the immutable launcher and
`/opt/argus/management.state`. After that one-time transition, `argus update`
advances the verified management state only; it does not replace
`/usr/local/bin/argus`. The launcher fails closed before Docker runs when that
state is missing or malformed. Rerun the signed installer to repair it rather
than editing the file by hand.

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

For SQLite, stop Argus and copy the database plus any `-wal` and `-shm` files
from its `argus-data` Docker volume, or use SQLite's online backup tooling.
Restore all files together. Signed updates also copy these files into a
timestamped `/opt/argus/backups/<version>-<timestamp>/` directory before
migration.

For PostgreSQL, use regular `pg_dump`/`pg_restore` or provider snapshots.
Store dumps outside `/opt/argus`; Argus update backups preserve deployment
state but do not replace database-native PostgreSQL backups.
Records and revisions are immutable history; current records can be rebuilt
from revisions if necessary. After restore, restart the scheduler and workers.
Idempotent identities prevent unchanged source items from duplicating.

Start recovery with bounded, redacted diagnostics:

```bash
argus doctor --json
argus status --json
argus logs --tail 200 --json
```

Run only the exact targeted `argus repair <service> --json --yes` recovery
returned by the doctor. If an update is unhealthy, preserve its backup and run
`argus update --rollback --json --yes`. If rollback verification also fails,
stop mutating the host, keep `/opt/argus`, its backups, and database volumes,
and inspect the reported service logs.

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

## Stable release promotion and rollback

Stable delivery is one checked-in bundle, not three independently deployable
files:

- `apps/web/public/releases/stable/install.sh`
- `apps/web/public/releases/stable/manifest.json`
- `apps/web/public/releases/stable/manifest.sig`

After the signed release workflow has published its immutable release, download
its `stable-promotion-input` artifact so those eight verified release files are
in `dist/release`. Render the new stable bundle only with the release tooling:

```sh
pnpm tsx scripts/release/promote-stable.ts dist/release apps/web/public/releases/stable
git diff -- apps/web/public/releases/stable
```

For a new release, the diff must contain changes to exactly `install.sh`,
`manifest.json`, and `manifest.sig` in that directory. The promotion command
first verifies the manifest signature against Argus's canonical stable
Ed25519 trust root. It embeds that same successfully verified root in the
stable installer and verifies the hash-bound candidate `release-public.pem`
alongside every other signed candidate asset; it then writes those three stable
members as one staged directory swap. Do not use an immutable GitHub release
`install.sh` at the stable URL: it is bound to that release's immutable manifest
URL, not the stable manifest URL.

Before committing, run the release verification and the clean-host installer
smoke described below against the verified candidate. Keep the promotion
focused, review it, and deploy it through the normal path. The pinned v0.1.13
bundle remains its recognized legacy wrapper
contract; do not regenerate it from the current durable launcher. The next
promotion carries the verified durable wrapper from its candidate artifact.
Push and pull-request CI enforce the same rule: if any stable bundle member
changes, all and only those three paths may change under the stable directory;
unrelated repository files may be included in the same commit.

If verification, promotion, or deployment fails, retain or restore the prior
complete bundle. Never repair production by changing one bundle member. Roll
back a deployed promotion by reverting its complete promotion commit, then
verify the restored three-file diff and public bytes; do not hand-edit or
selectively revert `install.sh`, `manifest.json`, or `manifest.sig`.

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
installer locks and temp paths, plus Docker/containerd binaries, configuration,
data roots, versions, daemon availability, and service state. The workflow
provides a fresh isolated host with no workloads. Before and after inspection,
the smoke takes repeated exact metadata/content-hash snapshots of
`/var/lib/docker` and `/var/lib/containerd`, allowing bounded startup churn to
settle and failing closed if the data never becomes stable. Snapshot files stay
inside the deleted private work directory; only hashes and metadata are
recorded, and they are never copied into failure artifacts or logs. The smoke
then installs the wrapper twice, verifies its signed-manifest checksum, byte
identity, and version after both installs, and applies a strict Web-only answers
file. Its API token is generated inside the disposable host and is not a user
or repository secret. Success requires `/opt/argus/state.json` to name the
expected release and `argus doctor --json` to report both `ok: true` and
`healthy: true`.

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

## VPS operation smoke

`.github/workflows/vps-smoke.yml` accepts an immutable signed release tag and
runs `scripts/e2e/vps-smoke.sh` against `ubuntu:24.04` and `debian:13`.
Each disposable clean userland installs the signed wrapper, applies the same
Web-only onboarding file twice, and requires the second deployment plan to
contain `changes: []`. It then checks `argus doctor --json` and
`argus status --json`, triggers a public HTTPS page controlled by the Argus
project, queries the stored Web record, calls managed SearXNG with
`format=json` on the private network, and rejects any published port other
than `8788`.

The harness is intentionally opt-in because it creates and removes
`/opt/argus` on the disposable runner:

```bash
ARGUS_VPS_E2E=1 \
ARGUS_INSTALLER_URL="<private GitHub release asset API URL>" \
ARGUS_MANIFEST_URL="https://github.com/GPSxtreme/argus/releases/download/v0.1.4/manifest.json" \
ARGUS_MANIFEST_ASSET_URL="<private manifest asset API URL>" \
ARGUS_EXPECTED_VERSION="0.1.4" \
ARGUS_CONTROLLED_WEB_URL="https://argus.gpsxtre.me/" \
ARGUS_GITHUB_TOKEN="<GitHub token with read access>" \
ARGUS_GITHUB_USER="<GitHub username, if the token cannot access /user>" \
scripts/e2e/vps-smoke.sh ubuntu:24.04
```

Never run this smoke on a workstation or an existing Argus VPS.
