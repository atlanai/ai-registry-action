# Architecture and threat model

ai-registry Action is a JavaScript action on the `node24` runtime (`action.yml`, bundle `dist/index.mjs`). It previews and publishes the exports an [ai-registry](https://github.com/atlanai/ai-registry) manifest declares, by running `aireg`. It has no database, daemon, telemetry or persistent state; git history and the registries own durable state. It has no runtime dependencies: the bundle is the TypeScript source in `src/`, compiled by `npm run build` and committed.

## Source layout

| Path | Owns |
| --- | --- |
| `src/main.ts` | The entry point, and the only code that reads `process.env`; everything else takes the environment as an argument, which is what lets the tests run every path |
| `src/run.ts` | Event routing |
| `src/action.ts` | Inputs, outputs, step summaries, masking, annotations and suspended workflow commands |
| `src/github.ts` | The GitHub REST client with bounded responses, pull-request context and bot-owned marker comments |
| `src/workspace.ts` | Working directory and manifest checks, and the hardened git runner |
| `src/install.ts` | Downloading, verifying and updating aireg, and installing adapters |
| `src/aireg.ts` | Running aireg and reading its answers |
| `src/tokens.ts` | Credentials, redaction and subprocess environments |
| `src/preview.ts` | The pull-request preview, including the temporary base checkout |
| `src/publish.ts` | Publishing, its default-branch and rerun guards, and the failure comment |
| `src/report.ts` | The preview comment, job summaries and outputs, with Markdown escaping |
| `src/constants.ts` | Limits, fixed endpoints and the CLI pin |

`run.ts` routes the event: `pull_request` previews; a default-branch `push` or `workflow_dispatch` publishes; `publish: false`, or a `schedule`, dry-runs; and anything else, including `pull_request_target`, is refused.

## Publish

1. Require the default branch, and on a rerun require that the run's commit is still the branch tip. Dry runs skip both guards, and get registry tokens only on the default branch, where a `schedule` always runs.
2. Read and mask `AIREG_TOKEN_*` credentials. Require the working directory to stay inside the workspace with no symbolic links, and `.registry/manifest.yml` to be a tracked, bounded, regular file.
3. Fetch aireg's stable release manifest, verify its Ed25519 signature against the pinned release key, and download this runner's binary at the exact size and SHA-256 the manifest states.
4. With no credentials, list the manifest's registries and install their signed adapters.
5. Run `aireg publish --yes --json`, plus `--dry-run` when requested, with an allowlisted environment and the named tokens, and with workflow commands suspended so aireg's output cannot issue them.
6. Validate the answer, then redact and escape it for outputs, the step summary and, when a publish fails, a comment on the merged pull request.
7. Remove the runtime directory on every exit.

## Pull-request preview

- Check out the base commit in a temporary worktree, fetching only that commit when absent, with an origin-scoped token in git's environment and hooks disabled.
- List both manifests without credentials. Pass registry tokens only when the pull request merges into the default branch and declares `registries:` exactly as the base does. Any change to them, a pull request into another branch, or an unreadable base passes no token, since an added or repointed registry's adapter would run beside the others' credentials.
- Dry-run head and base with the same tokens. An export both the registry and the pull request changed is a conflict; incomplete base evidence is reported as unchecked, never as clean.
- Update one comment on same-repository pull requests, with coding-agent links for a conflict or refusal, then apply the verdict. Forks get the job summary only. Always remove the base worktree.

## Trust boundaries

| Boundary | Untrusted data | Control |
| --- | --- | --- |
| Inputs and environment | paths, booleans, numbers, event payload | strict parsing; defaults only in `action.yml`; no shell interpolation |
| GitHub API | repository names, SHAs, comments | fixed `api.github.com` origin, pinned API version, no redirects, byte and page limits |
| Manifests in a pull request | registry declarations, export names, file paths | credentials only when `registries:` match the base exactly; cardinality bounds; escaping and redaction |
| CLI download | release manifest, status, headers, body | fixed `https://aireg.sh` origin, no redirects, size bounds, Ed25519 signature from a pinned release key, signed size and SHA-256 |
| aireg subprocesses | the verified CLI and its output | direct argument arrays, no shell, fixed `PATH`, action-owned home, allowlisted environment, tokens only for `publish`, workflow commands suspended |
| Release | the bundle consumers run | `dist/` rebuilt and compared with source in CI; immutable release tags |

## Invariants

- The action refuses `pull_request_target`, so pull-request content never runs with base-repository secrets.
- Registry credentials never reach installation, adapter installation or registry listing; aireg sends each only to its declared registry.
- A preview never turns absent, malformed, truncated or over-limit evidence into a clean or conflict verdict.
- Caller inputs cannot change install or API origins, executables, loaders, git configuration or shell commands.
- Every network and file-content read is bounded, and pull-request-controlled collections are bounded before they are processed.
- `dist/` is generated from reviewed source and committed with it.

## aireg release key

The action installs the release that `https://aireg.sh/channels/stable/manifest.json` names, so every run uses the latest aireg. It trusts that manifest only when one of the keys in `CLI_RELEASE_KEYS` (`src/constants.ts`) signed it, the same Ed25519 keys aireg itself trusts. When aireg rotates its release key, the new public key is added there in a new action release. It also refuses a signed release older than `MINIMUM_CLI_VERSION`, so an old manifest cannot be replayed to roll aireg back. `adapter install <id> --yes` installs each declared adapter, and `aireg-version` records what ran.

## Release boundary

Consumers run the git object their `uses:` reference selects. Full commit SHAs are the strongest pin; immutable `vX.Y.Z` tags and the moving `vX` tag are the readable defaults. Only the release workflow, using a GitHub App token from the `release` environment, can create or move `v*` tags; the tag ruleset blocks everyone else. There are no release assets beyond the repository itself, so the reviewed commit and its rebuilt bundle are the release evidence. [CONTRIBUTING.md](../CONTRIBUTING.md#releases) has the release steps.
