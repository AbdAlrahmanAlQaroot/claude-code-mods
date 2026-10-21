# Claude Code mods

Six small mods for Claude Code, written in TypeScript against its plugin hooks API. They add guard rails on tool calls, status line items, panes and slash commands: blocking risky git and shell commands, tracking your pull requests, gathering a standup, pacing session limits, showing which repo Claude is in, and keeping the Mac awake while work runs. Each mod is its own plugin, so you can install only the ones you want.

## Install

Add the marketplace from GitHub or from a local clone:

```
/plugin marketplace add AbdAlrahmanAlQaroot/claude-code-mods
/plugin marketplace add ~/path/to/claude-code-mods
```

Then install the mods you want:

```
/plugin install rules-guard@claude-code-mods
/plugin install pr-radar@claude-code-mods
```

The same works from a shell with `claude plugin marketplace add <source>` and `claude plugin install <name>@claude-code-mods`. Options are set with `/plugin` (pick the plugin, then configure) or `claude plugin configure <name>`. Restart the session after installing or changing options.

pr-radar and standup call the GitHub CLI, so `gh` must be installed and logged in. stay-awake and the pr-radar desktop notification are macOS only.

## rules-guard

Checks Bash, Write and Edit calls before they run and holds the ones that break a rule. Each block names the rule, the problem, where it was found, the fix, and when to ask the user, so Claude can correct itself and retry.

Rules:

- No direct push to a protected branch, including `--all`, `--mirror` and a bare `git push` from a protected branch.
- No plain force push. `--force-with-lease` is fine.
- No AI attribution lines (co-author trailers, session links, "generated with" lines) in commits, PRs, comments or files.
- No "Test plan" section in PR descriptions, and PR descriptions must be short bullet points.
- No new code comments in source files inside a git repo. Tool directives such as `@ts-` or `eslint-` lines and shebangs are allowed.
- No test files in commits. Tests stay local.
- No Slack messages sent by Claude. Drafts are allowed.
- No kubectl or aws calls aimed at production (a context, cluster or profile with "prod" in its name).
- Liquibase changesets must use your author name, when one is set.
- kubectl calls are held while the VPN is down, and kubectl and aws calls are held when the AWS SSO session is stale, when those checks are on.

Options:

- `protectedBranches`: comma-separated branch names. Default `main,master`.
- `liquibaseAuthor`: the only author allowed on Liquibase changesets. Default empty, which turns the check off.
- `vpnProcess`: process name that runs while your VPN is up, such as `openvpn`. Default empty, which turns the check off.
- `awsSsoCheck`: hold kubectl and aws calls when no AWS SSO session is fresh. Default `false`.

## pr-radar

Keeps the state of your open GitHub pull requests across every repo: review decision, CI checks, unresolved threads, conflicts, and PRs merged in the last three days. It shows a summary in the status line, refreshes every five minutes and after `gh pr` or `git push` commands, and tells you when a PR is approved, gets changes requested, starts or stops failing, gets new comments, merges or closes.

- `/prs` lists your PRs with links. `/prs pane` opens a live pane. `/prs refresh` fetches now.
- `/unreleased` compares `main` (or `master`) with your integration branch in each repo and lists the PRs and commits not yet released.
- Claude gets two tools, `my_prs` and `my_unreleased`, and prompts about PRs carry the live state as context.

Options:

- `alerts`: toast and macOS notification on PR changes. Default `true`.
- `sound`: play a sound with the notification. Default `true`.
- `repos`: comma-separated `owner/repo` list for `/unreleased`. Default empty, which uses only repos where you have a PR into the integration branch.
- `integrationBranch`: the branch work merges into before a release. Default `staging`.
- `login`: your GitHub login, used to mark your own commits in `/unreleased`. Default empty, which reads it from `gh api user`.

## standup

`/standup` opens a pane with what you did on a work day: PRs you opened, merged and reviewed, the commits you made, and the Claude Code sessions you worked in, grouped by repo. With no argument it shows the previous work day. It also accepts `today`, `yesterday` or a date like `2026-10-06`. The Draft button asks Claude to write the update.

Options:

- `repos`: comma-separated local repo paths to read commits from, including unpushed branches. Paths can be absolute, start with `~/`, or be relative to your home folder. Default empty, which uses GitHub search only.
- `utcOffset`: your time zone as an offset from UTC, such as `+03:00`. Default `+00:00`.
- `workDays`: comma-separated work days. Default `Mon,Tue,Wed,Thu,Fri`.
- `draftCommand`: a slash command the Draft button runs with the day as its argument. Default empty, which sends Claude a prompt with the day's activity instead.

## usage-pacer

Shows session-limit usage in the status line with the time until each window resets, and shows a toast once at 80% and once at 95% of each window.

Options:

- `sonnetSubagentsAbove`: when usage of any window is above this percent, general-purpose subagents with no model of their own run on Sonnet. Default `0`, which turns it off.
- `handoffAt`: when the 5-hour window reaches this percent, run your own `/handoff` command once in the session you are actively working in. Default `0`, which turns it off.

## repo-context

Shows the repo and branch Claude is working in on the status line, following `cd` and `git -C` in its commands. It also names a new session from its first real prompt, using a short Haiku call.

No options.

## stay-awake

Keeps the Mac from idle-sleeping while a turn or a background agent runs, using `caffeinate`, and lets it sleep again once everything is done.

No options.

## License

MIT. See [LICENSE](LICENSE).
