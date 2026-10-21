# rules-guard

Checks Bash, Write and Edit calls before they run and holds the ones that break a rule. Each block names the rule, the problem, where it was found, the fix, and when to ask the user, so Claude can correct itself and retry.

Always on:

- No direct push to a protected branch, including `--all`, `--mirror` and a bare `git push` from a protected branch. A bare push whose branch cannot be told is held until the branch is named.
- No plain force push. `--force-with-lease` is fine.
- No kubectl or aws calls aimed at production (a context, cluster or profile with "prod" in its name).

Optional (off by default):

- `noAiAttribution`: block AI attribution lines (co-author trailers, session links, "generated with" lines) in commits, PRs, comments and files.
- `noTestPlan`: block a "Test plan" section in PR descriptions.
- `prBulletsOnly`: PR descriptions must be 20 lines or fewer of short bullet points, with no prose paragraphs.
- `noCodeComments`: block new code comments in source files inside a git repo. Tool directives such as `@ts-` or `eslint-` lines and shebangs are allowed.
- `noTestFiles`: block a git commit that would include test files.
- `noSlackSend`: block Claude from sending or scheduling Slack messages. Drafts are allowed.
- `liquibaseAuthor`: the only author allowed on Liquibase changesets. Empty turns the check off.
- `vpnProcess`: process name that runs while your VPN is up, such as `openvpn`. When set, kubectl calls are held while it is not running.
- `awsSsoCheck`: hold kubectl and aws calls when no AWS SSO session in `~/.aws/sso/cache` is fresh.

Other options:

- `protectedBranches`: comma-separated branch names. Default `main,master`.

## Install

```
/plugin marketplace add AbdAlrahmanAlQaroot/claude-code-mods
/plugin install rules-guard@claude-code-mods
```

Turn on the optional rules from `/plugin` > rules-guard > options.

## What it runs and reads

rules-guard makes no network calls and sends nothing anywhere. It only reads the tool call Claude is about to make, and in some cases:

- runs `git` (`rev-parse`, `diff --name-only`, `add --dry-run`) in the repo the call targets, to find the current branch and the files a commit would include;
- runs `kubectl config current-context` before a kubectl call, to see whether it points at production;
- runs `pgrep -x <vpnProcess>` when `vpnProcess` is set;
- lists `~/.aws/sso/cache` and reads only the `expiresAt` field of each file when `awsSsoCheck` is on. Tokens are never kept or sent.

## License

MIT
