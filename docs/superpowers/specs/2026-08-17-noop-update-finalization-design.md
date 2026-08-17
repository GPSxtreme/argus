# Healthy No-op Update Finalization

## Problem

Argus v0.1.15 persisted `backup.sqliteFiles` in `update-state.json`. Argus v0.1.20 replaced that unsafe host-file model with a verified Docker named-volume `sqliteSnapshot` and correctly rejects the obsolete field in its strict rollback schema.

After a successful v0.1.15 to v0.1.20 update, a later already-current `argus update` verifies the signed v0.1.20 release and healthy deployment, but then unnecessarily parses the obsolete rollback journal during finalization. The strict parse fails with `UPDATE_ROLLBACK_UNAVAILABLE`, turning a healthy no-op into an error.

## Design

An ordinary no-op update whose signed current release already matches the deployed release may finish from a terminal journal without parsing its rollback metadata. The deployment finalizer will read only a narrow terminal identity: `phase: "verified"` plus the complete signed release snapshot. If that release exactly matches the verified deployed release, finalization returns the healthy no-op result and leaves the journal byte-for-byte unchanged.

The CLI update orchestration will still:

1. verify the target and current signed release identities;
2. verify the deployed service images match that release;
3. run the normal runtime health check;
4. reconcile signed context when required;
5. repair management state from the verified current release;
6. validate that any terminal journal names the same complete signed release.

The narrow terminal reader does not accept rollback state. It validates only a `verified` phase and the existing strict release snapshot, while allowing unrelated journal fields to remain opaque.

Every non-terminal phase, including `restarted`, continues through the existing strict transaction parser and finalizer. This is required because signed context can already be promoted when management promotion fails, leaving no pending context even though transaction finalization is incomplete. Interrupted and restarted transactions therefore remain fail-closed and must carry a valid current-schema rollback snapshot before they can be finalized.

## Safety Boundary

This change does not add a legacy parser, migration, fallback, or rollback path. A v0.1.15 `sqliteFiles` backup remains invalid for rollback because it is not a verified named-volume snapshot. `argus update --rollback` must continue to reject it.

No-op success proves only that the exact signed current release is deployed, healthy, and named by a terminal verified journal. It does not claim that obsolete rollback metadata became usable.

## Tests

Add an end-to-end CLI regression using a real v0.1.15-shaped terminal journal containing `backup.sqliteFiles: []` after a current signed release is deployed. Assert that:

- `argus update --json --yes` succeeds and reports the current healthy version;
- Docker mutation commands are not run; the read-only health query is allowed;
- signed context, management state, deployment state, and the legacy journal remain unchanged except for an allowed repair of stale management state;
- rollback still fails closed with `UPDATE_ROLLBACK_UNAVAILABLE`;
- a `restarted` journal cannot use the terminal fast path, even after signed context has already been promoted;
- existing pending/restarted recovery tests still require strict finalization and reach `verified` only with a valid native snapshot.

## Non-goals

- Converting or deleting old update journals.
- Treating `sqliteFiles` as a valid SQLite backup.
- Changing non-noop update, rollback, snapshot, or restore behavior.
