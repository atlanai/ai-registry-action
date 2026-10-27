import fsp from "node:fs/promises";
import { annotate, type Environment, getInput, maskSecret, repositoryOf, setOutput, writeStepSummary } from "./action.ts";
import {
  AiregOutputTooLarge, AiregRefusal, dryRunResult, type Execute, publishedResult, type PublishResult, runAireg,
  runAiregPublish
} from "./aireg.ts";
import { ACTION_NAME, COMMIT_SHA, PUBLISH_FAILURE_MARKER } from "./constants.ts";
import { defaultBranchOf, githubRequest, type GitHubRequest, repositoryPath, upsertMarkerComment } from "./github.ts";
import { type Install, installCli } from "./install.ts";
import { exportChanges, formatPublishFailureComment, formatPublishSummary, setPublishOutputs } from "./report.ts";
import { suppliedTokens } from "./tokens.ts";
import { assertManifest, resolveWorkingDirectory } from "./workspace.ts";

export interface PublishOptions {
  environment: Environment;
  payload?: unknown;
  dryRun: boolean;
  request?: GitHubRequest;
  install?: Install;
  execute?: Execute;
}

type PublishFlow = Required<Pick<PublishOptions, "environment" | "dryRun" | "install" | "execute">> & { trusted: boolean };

const STALE_RERUN_ADVICE = `run ${ACTION_NAME} manually from the default branch instead`;

/** Whether this run is on the default branch, whose manifest was reviewed. GitHub runs schedules only from it. */
export function onDefaultBranch(environment: Environment, payload: unknown): boolean {
  if (environment.GITHUB_EVENT_NAME === "schedule") return true;
  const branch = defaultBranchOf(payload);
  return branch !== undefined && environment.GITHUB_REF === `refs/heads/${branch}`;
}

/** Publishing follows only the default branch's reviewed manifest, whatever the workflow's triggers allow. */
export function assertDefaultBranch(environment: Environment, payload: unknown): void {
  if (!onDefaultBranch(environment, payload)) throw new Error(`${ACTION_NAME} publishes only from the repository's default branch`);
}

/** Refuses a rerun whose commit is not the default branch's tip, so older artifacts cannot overwrite newer ones. */
export async function assertCurrentRerun(environment: Environment, payload: unknown, request: GitHubRequest): Promise<void> {
  if (!(Number(environment.GITHUB_RUN_ATTEMPT) > 1)) return;
  const token = getInput(environment, "github-token");
  const repository = repositoryOf(environment);
  const branch = defaultBranchOf(payload);
  let tip: unknown;
  if (token && repository && branch !== undefined) {
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    tip = await request({ token, method: "GET", requestPath: `${repositoryPath(repository)}/git/ref/heads/${ref}`, expectedStatus: 200 })
      .then(found => (found as { object?: { sha?: unknown } } | undefined)?.object?.sha, () => undefined);
  }
  if (typeof tip !== "string" || !COMMIT_SHA.test(tip)) {
    throw new Error(`this rerun could not confirm the default branch's latest commit, so it did not publish; ${STALE_RERUN_ADVICE}`);
  }
  const sha = environment.GITHUB_SHA ?? "";
  if (tip.toLowerCase() !== sha.toLowerCase()) {
    throw new Error(`this rerun is for ${sha.slice(0, 7)}, but ${branch} has moved on to ${tip.slice(0, 7)}, so publishing it would put older artifacts over newer ones; ${STALE_RERUN_ADVICE}`);
  }
}

/** A failed publish is otherwise only a failed run, so the merged pull request it came from is told. */
export async function reportPublishFailure(environment: Environment, payload: unknown, error: unknown, request: GitHubRequest): Promise<void> {
  const token = getInput(environment, "github-token");
  const sha = (payload as { after?: unknown } | undefined)?.after;
  const repository = repositoryOf(environment);
  if (!token || typeof sha !== "string" || !COMMIT_SHA.test(sha) || !repository) return;
  maskSecret(token);
  try {
    // The pinned API version omits merge_commit_sha, so the pull request is the one merged into the default branch.
    const pulls = await request({ token, method: "GET", requestPath: `${repositoryPath(repository)}/commits/${sha}/pulls`, expectedStatus: 200 });
    const branch = defaultBranchOf(payload);
    const merged = (Array.isArray(pulls) ? pulls as { merged_at?: unknown; base?: { ref?: unknown }; number?: unknown }[] : [])
      .filter(pull => typeof pull?.merged_at === "string" && pull.base?.ref === branch && Number.isSafeInteger(pull.number));
    const [pull] = merged;
    if (merged.length !== 1 || pull === undefined) {
      annotate("notice", ACTION_NAME, "no single merged pull request introduced this commit, so the failed run is the report");
      return;
    }
    await upsertMarkerComment({
      token, request, ...repository, issueNumber: pull.number as number, marker: PUBLISH_FAILURE_MARKER,
      body: formatPublishFailureComment(environment, sha, error)
    });
  } catch {
    annotate("warning", ACTION_NAME, "the failed publish could not be reported on its pull request");
  }
}

type PublishRun = { version: string; result: PublishResult } | { version: string; failure: AiregRefusal };

async function publishOnce({ environment, dryRun, install, execute, trusted }: PublishFlow): Promise<PublishRun> {
  const supplied = suppliedTokens(environment);
  // Another branch's manifest is unreviewed, so it could point a registry's name, and its token, anywhere.
  const tokens = trusted ? supplied : {};
  if (!trusted && Object.keys(supplied).length > 0) {
    annotate("notice", ACTION_NAME, "registry tokens are passed only on the default branch, so this dry run ran without them");
  }
  const cwd = resolveWorkingDirectory(environment);
  assertManifest(cwd);
  const { binary, directory, version } = await install({ environment, cwd });
  try {
    const raw = await runAiregPublish({ binary, runtimeDirectory: directory, cwd, environment, tokens, dryRun, execute });
    return { version, result: dryRun ? dryRunResult(raw) : publishedResult(raw) };
  } catch (error) {
    // A completed publish already wrote to the registry, so an unreadable answer is reported, not failed.
    if (error instanceof AiregOutputTooLarge && !dryRun) return { version, result: publishedResult("") };
    if (error instanceof AiregRefusal) return { version, failure: error };
    throw error;
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

async function publishWithOutputs(options: PublishFlow): Promise<void> {
  const { environment, dryRun } = options;
  let run: PublishRun;
  try {
    run = await publishOnce(options);
  } catch (error) {
    setPublishOutputs(environment);
    setOutput(environment, "status", "failed");
    throw error;
  }
  setPublishOutputs(environment, "result" in run ? run.result : undefined);
  setOutput(environment, "status", "failure" in run ? "failed" : "success");
  setOutput(environment, "aireg-version", run.version);
  if ("failure" in run) {
    // aireg's own answer here is how to sign in on a workstation, which would mislead on a runner.
    if (!options.trusted && run.failure.reason.code === "unauthorized") {
      throw new Error("this dry run is not on the default branch, so it ran without registry tokens, and the registry needs one; preview the branch in a pull request, or dry-run the default branch");
    }
    throw run.failure;
  }
  writeStepSummary(environment, formatPublishSummary(run, environment));
  const { published, unchanged } = exportChanges(run.result);
  const counts = `${published.length}, unchanged ${unchanged.length}, skipped ${run.result.skipped.length}`;
  annotate("notice", ACTION_NAME, dryRun ? `would publish ${counts} (dry run)` : `published ${counts}`);
}

export async function runPublish({
  environment, payload, dryRun, request = githubRequest, install = installCli, execute = runAireg
}: PublishOptions): Promise<void> {
  if (!dryRun) {
    assertDefaultBranch(environment, payload);
    await assertCurrentRerun(environment, payload, request);
  }
  try {
    await publishWithOutputs({ environment, dryRun, install, execute, trusted: onDefaultBranch(environment, payload) });
  } catch (error) {
    if (!dryRun && environment.GITHUB_EVENT_NAME === "push") await reportPublishFailure(environment, payload, error, request);
    throw error;
  }
}
