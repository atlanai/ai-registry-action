# Contributing

Thanks for improving ai-registry Action. Bug reports and focused pull requests are welcome. Problems with aireg itself, adapters or the manifest format belong in [ai-registry](https://github.com/atlanai/ai-registry).

Security vulnerabilities do not belong in public issues; follow [SECURITY.md](SECURITY.md) instead.

## Development setup

Install Node 24 (the version in `.node-version`), clone the repository, and install the locked development dependencies without lifecycle scripts:

```bash
npm ci --ignore-scripts
```

The source is strict TypeScript in `src/`, which Node runs directly in tests. GitHub runs the committed bundles in `dist/`, so source and bundle changes travel together. The action has no runtime dependencies, not even the GitHub Actions toolkit: `src/action.ts` and `src/github.ts` cover the few workflow commands and REST calls it needs, which keeps the reviewed bundle small. Please keep it that way.

## Making a change

Keep changes narrow and fix the shared root cause once, at the trust boundary. Reuse what `src/` already has and Node's standard library provide before adding code. Do not add configuration for values that do not vary.

For a behaviour change:

1. Add or update a focused test in the `test/` file that matches the module you changed (`test/preview.test.ts` for `src/preview.ts`, and so on).
2. Update `README.md`, `action.yml`, `docs/` or `SECURITY.md` when their contract changes, and add a line to `CHANGELOG.md`.
3. Run `npm run build` and commit the regenerated `dist/`; never edit it by hand.

Tests must be hermetic: synthetic repositories, credentials and IDs, temporary directories cleaned up after each test, and no network access. Rendered comments use Node's snapshot testing; after an intended change, refresh the snapshots with `node --test --test-update-snapshots "test/**/*.test.ts"` and review the diff.

## Checks

```bash
npm run check   # typecheck, tests with coverage thresholds, build, and a clean dist/
git diff --check
```

`npm run check` ends by confirming `dist/` matches the source, so it fails until you commit a rebuilt bundle. CI also runs on macOS, runs the committed bundle against a credential-free manifest, and scans workflows with zizmor and the code with CodeQL.

Publishing and preview support Linux and macOS. Windows is not supported.

## Pull requests

Explain the user-visible effect and why the change is the smallest one that fixes the root cause, and list the checks you ran. Call out anything touching credentials, CLI verification, network destinations, `pull_request_target`, workflows, generated bundles, dependencies or releases; those need maintainer review.

## Releases

Maintainers release with one pull request that sets the version (`npm version --no-git-tag-version X.Y.Z`) and adds a `## X.Y.Z - YYYY-MM-DD` entry to `CHANGELOG.md`. When it merges, the release workflow runs CI on that commit, tags `vX.Y.Z`, moves `vX` and publishes the GitHub release. Exact tags are never moved or deleted; a fix ships as a new patch release. The release job pushes tags with a GitHub App token from the `release` environment (variable `RELEASE_APP_CLIENT_ID`, secret `RELEASE_APP_PRIVATE_KEY`); the tag ruleset lets only that App create or move `v*` tags. When aireg rotates its release signing key, add the new public key to `CLI_RELEASE_KEYS` in `src/constants.ts`, and raise `MINIMUM_CLI_VERSION` there to the aireg release the action was tested with.
