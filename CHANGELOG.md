# Changelog

This project follows [semantic versioning](https://semver.org/). Within a major version, releases keep documented inputs and outputs compatible, and the moving `v1` tag follows the latest `1.x` release.

## 1.0.1 - 2026-10-27

- A dry run on a branch other than the default branch no longer receives registry tokens, since that branch's manifest is unreviewed.
- A pull request that changes any `registries:` declaration gets no registry token, because an added or repointed registry's adapter would run beside the others' credentials.
- The action refuses a signed aireg release older than 0.1.7, so an old release manifest cannot be replayed.
- Each release waits for a maintainer's approval before its tags are pushed.

## 1.0.0 - 2026-10-27

ai-registry Action, the GitHub Action for [ai-registry](https://github.com/atlanai/ai-registry), previews `aireg publish` on pull requests and publishes on merge, for any registry a `.registry/manifest.yml` declares.

- Each pull request gets one comment: a heading such as "✅ Ready to merge", one line on what merging publishes and where, then a table of each artifact's change and version, with the files it deletes in its row.
- A conflict, an artifact both the pull request and the registry changed since the pull request's base, fails the check unless `fail-on-conflict` is `false`. Conflict and refusal comments end with a prompt for any coding agent and Fix in Claude Code and Fix in Codex buttons; forks get neither.
- A pull request gets a registry token only when it merges into the default branch and declares that registry exactly as its base does. Publishing happens only on the default branch, and a stale rerun never publishes older artifacts over newer ones.
- The action installs the latest aireg release after verifying its signed release manifest against aireg's release key, and checks the binary against the size and SHA-256 that manifest states. aireg's output cannot issue workflow commands, and credentials are redacted from every report.
- The action has no runtime dependencies.
