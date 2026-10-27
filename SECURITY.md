# Security policy

## Reporting a vulnerability

Don't report security vulnerabilities in public issues, discussions or pull requests.

Report them privately by [opening a draft security advisory](https://github.com/atlanai/ai-registry-action/security/advisories/new) on GitHub. If you can't use GitHub, email [security@atlan.com](mailto:security@atlan.com).

Please include:

- what is affected: the action release or commit, and the `aireg-version` output of the run
- the steps to reproduce it, with the smallest workflow and manifest you can share
- what an attacker could do with it

We'll acknowledge your report within 3 business days and work with you to verify and fix the issue. We'll agree a disclosure date with you, request a CVE when one is warranted, and credit you in the advisory under the name you choose, or not at all if you prefer.

## What counts as a vulnerability

The action runs in workflows that hold registry tokens and a GitHub token, and its pull-request preview reads content that a pull request controls.

These are vulnerabilities:

- a registry token reaches anything other than `aireg publish`, or a registry other than the one declared for it
- a pull request gets a token for a registry it added or changed
- the action runs pull-request content with base-repository secrets, or runs on `pull_request_target`
- the action runs an aireg binary that aireg's release key did not sign, or that differs from the size and digest its signed manifest states
- pull-request content issues workflow commands, sets outputs, or injects Markdown that misleads a reviewer in the preview comment
- the action publishes from a branch other than the default branch, or a stale rerun publishes older artifacts over newer ones
- a token value appears in a comment, summary, output or log

These are not:

- what a skill or agent does once someone installs it. See [ai-registry's security policy](https://github.com/atlanai/ai-registry/blob/main/SECURITY.md) for aireg, its installer and its release files
- changes made by someone with write access to the default branch, the workflow or the protected environment
- a workflow that passes a token with more access than the job needs

This policy covers this repository's action, its committed bundle and its release tags. Vulnerabilities in aireg itself belong to [ai-registry](https://github.com/atlanai/ai-registry/security/advisories/new).

## Supported versions

Only the latest release of the current major version, `v1`, receives security fixes. Fixes ship in a new release; workflows on `@v1` pick them up automatically, and workflows pinned to a commit SHA should move to the new release's SHA.

## Security model

- Registry credentials come only from the step environment, as `AIREG_TOKEN_<NAME>`. They are masked, redacted from every report and output, and passed only to `aireg publish`; installation, self update, adapter installation and registry listing run without them.
- The action installs the latest aireg release from `https://aireg.sh` only after verifying the release manifest's Ed25519 signature against aireg's release key, pinned in the action, and it runs the binary only when its size and SHA-256 match that signed manifest. It refuses a signed release older than the minimum version it pins, so an old manifest cannot be replayed to install a fixed bug again. Downloads refuse redirects and are size-bounded. aireg and its adapters then run in an action-owned home, with an allowlisted environment and no shell.
- Real publishing happens only on the default branch, from its reviewed `.registry/manifest.yml`, and a rerun publishes only while its commit is still the branch tip. A dry run on any other branch gets no registry token. Protect publish credentials with a GitHub environment and review manifest changes like workflow changes.
- Previews run on `pull_request`, never `pull_request_target`. A credential is passed only when the pull request merges into the default branch and declares `registries:` exactly as its base commit does. Any change to them, a pull request into another branch, whose base anyone with push access could have repointed, and an unreadable base release none, because a registry a pull request adds runs its adapter beside the others' credentials. Fork pull requests receive no secrets and no comment.
- Releases wait for a maintainer's approval in the `release` environment before any tag is pushed. Exact `vX.Y.Z` tags can never be updated or deleted.
- Conflict and refusal previews link to Claude Code and Codex over `https` only, with a redacted prompt that marks pull-request names and messages as data. A link only opens the agent with that prompt; nothing runs from the comment itself. Fork pull requests get no links, because their author controls the branch.
- aireg reads artifact content without executing it. Its answers are bounded and validated, workflow commands are suspended while it runs, and reports escape untrusted text.
- A confirmed conflict fails the preview after it is reported when `fail-on-conflict` is on. Missing credentials and incomplete comparison evidence are reported as not compared, never as clean or conflicting.
- The GitHub API and git hosts are fixed to github.com. A run on another GitHub host fails before the job's token is sent, rather than sending it to github.com.
- The action has no runtime dependencies. `dist/` is rebuilt and compared with its source in CI, which also scans workflows with zizmor and the code with CodeQL.

See the [architecture and threat model](docs/ARCHITECTURE.md) for the full trust-boundary description.
