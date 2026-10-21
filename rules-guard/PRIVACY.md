# rules-guard privacy

rules-guard collects no data and makes no network calls. It has no server, no analytics and no telemetry.

It runs inside Claude Code on your machine and only looks at the tool call Claude is about to make. To decide whether to hold that call it may run `git`, `kubectl config current-context` or `pgrep` locally, and, when `awsSsoCheck` is on, read the `expiresAt` field of the files in `~/.aws/sso/cache`. Nothing it reads is stored or sent anywhere.

Questions: https://github.com/AbdAlrahmanAlQaroot/claude-code-mods/issues
