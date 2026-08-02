# Setup choices

Ask only for requirements that the live `argus config schema --json` accepts.
Do not copy fields from this reference and do not ask for secret values.

| Need | Default / decision |
| --- | --- |
| Host | VPS Docker only. Stop if the requested target is not a VPS Docker host. |
| Storage | SQLite unless the user explicitly requests split services or PostgreSQL. |
| Web queries | Use managed SearXNG when any web query is configured. |
| X | Use managed FxEmbed when X is enabled and no endpoint already exists. Explain that the CLI will request the Cloudflare credential through a hidden prompt. |
| Telegram | Accept public channels only. Stop for private chats or private channels. |
| Intelligence | Disable it unless the user explicitly requests it. |

Record watch sources, schedules, public channel names, endpoints, storage, and
the non-secret Cloudflare account identifier only when the live schema asks for
them. Before mutation, run the CLI's non-mutating onboarding inspection with
the answers file and inspect its JSON result.

Successful JSON commands use this envelope shape:

```json
{"contractVersion":1,"ok":true,"data":{}}
```
