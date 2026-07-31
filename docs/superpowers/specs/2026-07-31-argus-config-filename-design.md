# Argus configuration filename rename

## Decision

Rename the default runtime configuration from `argus.config.yaml` to
`argus.yaml`, and rename the distributed sample from
`argus.config.example.yaml` to `argus.example.yaml`.

## Scope

- Rename the sample file in the repository.
- Change CLI and runtime default paths to `argus.yaml`.
- Change Docker image and Compose mount paths to `argus.yaml`.
- Update environment examples, user documentation, and architecture references.
- Keep `ARGUS_CONFIG` as the explicit path override.

There is no compatibility alias because Argus has not yet been released and the
shorter name is the new V1 contract.

## Verification

- Search the tracked repository for obsolete filename references.
- Run the full test suite, typecheck, and build.
- Validate the CLI against `argus.example.yaml`.
- Validate the Compose configuration.
