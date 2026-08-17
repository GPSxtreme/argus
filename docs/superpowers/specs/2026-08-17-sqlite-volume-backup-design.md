# SQLite Docker-Volume Backup and Rollback Design

## Summary

Argus currently stores the default SQLite database in the Compose-managed
`argus-data` Docker volume mounted at `/app/data`. The signed-update backup
implementation instead searches the host instance root and `root/data`, so a
real VPS update records a successful backup without copying the database. The
existing tests reproduce only the incorrect host-directory topology.

SQLite updates will briefly stop the Argus service, discover and validate its
exact Compose data volume, create a verified snapshot through a network-disabled
helper container, and only then continue the signed update. Rollback will verify
the same snapshot before changing runtime data and restore it while Argus is
stopped. PostgreSQL behavior remains unchanged.

## Goals

- Make every non-noop SQLite update capture the actual database stored in the
  deployed Docker volume.
- Fail closed before image pull, migration, or restart when the volume or
  snapshot cannot be proven safe.
- Restore the verified snapshot during rollback before starting the signed
  prior application image.
- Preserve the existing signed-release, deployment-state, and rollback-release
  trust boundaries.
- Prove the real named-volume topology in automated tests and permanent-VPS
  acceptance.
- Keep operation automatic behind `argus update`; no new operator input or
  database path configuration is required.

## Non-goals

- Zero-downtime SQLite updates are not required. The operator approved brief
  downtime in exchange for a simpler consistent snapshot.
- This work does not add scheduled backups, remote backup destinations,
  retention policy, PostgreSQL dumps, or a general backup command.
- This work does not address job retention, Docker log rotation, SearXNG engine
  selection, or Web raw-payload revision growth. Those are separate soak-test
  follow-ups.
- Legacy host-path SQLite backup discovery is removed rather than retained as a
  fallback.

## Proven failure

The permanent VPS provided the production topology and failure evidence:

- Compose mounts `argus_argus-data` at `/app/data`.
- SQLite contained 1,145 records, 2,388 revisions, and 11,250 jobs at the final
  soak checkpoint.
- Existing `/opt/argus/backups/*` directories contained deployment state and
  release context but no `argus.db`, WAL, or SHM files.
- `packages/deployment/src/update.ts` searched only the instance root and
  `root/data`.
- `packages/deployment/test/update.test.ts` created database fixtures directly
  beneath those host paths, so the test asserted a topology that Compose never
  deploys.

The soak database was separately checkpointed and verified before the VPS stack
was stopped. That operational checkpoint is evidence, not an implementation
substitute.

## Chosen approach

### Quiesced helper container

Argus will use Docker and Compose as the storage boundary:

1. inspect the selected `argus` Compose service and resolve its single volume
   mounted at `/app/data`;
2. validate that the mount is a named Docker volume owned by the exact Compose
   project and logical volume;
3. stop only the `argus` service;
4. run the currently verified, digest-pinned Argus application image as a
   one-shot helper with no network, the data volume mounted at `/data`, and a
   staging backup directory mounted at `/backup`;
5. use SQLite's backup API to write a single consistent `argus.db` snapshot;
6. run `PRAGMA quick_check`, capture the snapshot SHA-256 and useful row counts,
   fsync the snapshot and its containing directory, then atomically publish the
   backup metadata;
7. continue the existing pull, migration, restart, and health flow only after
   the snapshot is durable.

The helper uses the signed current application image already bound by persisted
deployment state. It receives no secrets, no host network, and no Docker socket.
Its mounts are limited to the exact data volume and one update-backup directory.

### Rejected alternatives

Raw `docker cp` from the stopped service was rejected because it depends on a
particular container identity and makes verified, atomic restore substantially
harder. An online backup while ingestion remains active was rejected because
the small downtime saving does not justify extra concurrency, permission, and
failure-order complexity for the single-VPS SQLite mode.

## Volume discovery and validation

The implementation must not construct `argus_argus-data` from strings. It will
resolve the `argus` service container through Compose, inspect its mounts, and
require exactly one mount with all of these properties:

- destination exactly `/app/data`;
- Docker mount type `volume`;
- a non-empty volume name;
- Docker volume labels identifying Compose project `argus` and logical volume
  `argus-data`.

Missing, duplicated, bind-mounted, unlabeled, or mismatched mounts abort with a
stable deployment error before stopping the service. Docker and Compose output
is parsed structurally; paths and identifiers are never taken from untrusted
stdout without validation.

## Backup contract

The persisted update state replaces the obsolete host-relative `sqliteFiles`
list with an optional SQLite snapshot record containing:

- a path confined beneath the selected update backup directory;
- SHA-256;
- byte length;
- SQLite `quick_check` result;
- captured record, revision, and job counts; and
- the discovered Docker volume identity.

SQLite plans require this snapshot. PostgreSQL plans omit it. A SQLite backup is
not considered committed until snapshot bytes, metadata, and parent directory
have been synchronized. Temporary files and directories use unpredictable names
under the final backup parent and are never selected by rollback.

The previous service is restarted automatically if volume discovery succeeded
but stopping, snapshot creation, verification, or durable publication fails.
The update returns the original failure plus bounded recovery guidance. It does
not pull or migrate the target release after a backup failure.

## Rollback contract

Rollback performs all non-mutating checks first:

1. verify the signed rollback release and persisted update transaction;
2. confine the backup path beneath the instance backup root;
3. verify the snapshot size, SHA-256, SQLite header, `quick_check`, and volume
   identity with a network-disabled helper;
4. confirm the current Compose service still mounts that exact volume.

Only then does rollback stop Argus. The helper copies the verified snapshot to
an unpredictable staged file inside the volume, synchronizes it, and atomically
renames it to `/data/argus.db`. Existing `argus.db-wal` and `argus.db-shm` files
are removed while the service is stopped so they cannot be replayed against the
restored database. The helper synchronizes the volume directory before exit.

Rollback then starts the signed prior image and runs the existing health check.
Deployment state, signed release context, and management state are promoted only
after health succeeds, preserving the established ordering. Snapshot bytes and
metadata are retained regardless of success for operator recovery.

## Error and recovery behavior

- Volume discovery failure: no service mutation; explain that the managed
  `/app/data` volume could not be proven.
- Stop failure: no snapshot or update; preserve current deployment state.
- Snapshot or verification failure: restart the current signed release, retain
  diagnostic staging material when ownership is certain, and do not advance the
  update transaction.
- Snapshot tampering or deletion: reject rollback before stopping Argus.
- Restore failure before atomic rename: keep the current database selected and
  fail closed.
- Restore failure after atomic rename or directory synchronization ambiguity:
  do not guess; retain the verified snapshot and report the exact recovery
  location.
- Health failure after restore: retain snapshot and update state; do not promote
  signed identity or management state.

Errors and logs include stable codes, phase, service, and safe volume identity.
They never include secrets, raw configuration, Docker environment values, or
database content.

## Testing

### Unit and failure-order tests

Deployment tests cover exact command ordering, volume-inspection parsing,
ambiguous/malicious mount rejection, SQLite versus PostgreSQL behavior,
restart-on-backup-failure, snapshot metadata validation, path confinement,
checksum and quick-check rejection, stale-sidecar removal, and health-before-
identity promotion.

Fault injection covers snapshot creation, verification, fsync, metadata
publication, restore staging, rename, directory sync, restart, and health. Each
test asserts both selected database state and absence of later side effects.

### Named-volume integration regression

A Docker-backed test creates an isolated Compose project with a real named
volume, writes a SQLite database only inside that volume, and proves:

1. no host `root/data/argus.db` exists;
2. backup captures and verifies the volume database;
3. target migration mutates the live volume;
4. rollback restores the prior rows from the verified snapshot; and
5. containers, networks, volumes, and temporary backups are removed after the
   test.

The test uses digest-pinned project images, bounded timeouts, unique project
names, and deterministic cleanup. It must run in the CI environment that has
Docker rather than silently passing through a host-path fake.

### Release and VPS acceptance

The clean-host/VPS workflow verifies that a SQLite release update creates a
non-empty verified snapshot for the named volume before migration. A controlled
post-update record is added, rollback is explicitly authorized in the isolated
acceptance fixture, and the prior database contents are verified after rollback.
The permanent user dataset is never used for destructive rollback testing.

## Documentation

Operator documentation will state that signed SQLite updates briefly stop the
Argus service and create a verified snapshot from the managed Docker volume.
It will distinguish update rollback snapshots from scheduled/off-host backups
and remove the false claim that existing host-path copies already protect the
volume. Recovery examples will reference only persisted, verified backup
metadata.

## Delivery order

1. Replace the host-path backup contract with strict Docker-volume discovery.
2. Implement quiesced snapshot creation and restart-on-failure.
3. Implement verified atomic volume restore.
4. Add named-volume integration and failure-order coverage.
5. Update operator documentation and VPS acceptance.
6. Run Node 24 focused and full quality gates, obtain independent review, merge,
   publish a signed release, and repeat the movie/TV soak test from a clean
   checkpoint.
