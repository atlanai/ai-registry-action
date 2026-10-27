import { type Environment, getInput, readEventPayload } from "./action.ts";
import { ACTION_NAME, GITHUB_SERVER } from "./constants.ts";
import { runPreview } from "./preview.ts";
import { runPublish } from "./publish.ts";

interface Flows {
  preview: typeof runPreview;
  publish: typeof runPublish;
}

const EVENTS = new Set(["pull_request", "push", "workflow_dispatch", "schedule"]);

export async function run(environment: Environment, { preview, publish }: Flows = { preview: runPreview, publish: runPublish }): Promise<void> {
  // The job's token goes to github.com only, so a run on another GitHub host stops before sending it there.
  const server = environment.GITHUB_SERVER_URL;
  if (server !== undefined && server.replace(/\/$/, "") !== GITHUB_SERVER) {
    throw new Error(`${ACTION_NAME} supports repositories on github.com only, not GitHub Enterprise Server or GHE.com`);
  }
  const event = environment.GITHUB_EVENT_NAME ?? "";
  if (event === "pull_request_target") {
    throw new Error(`${ACTION_NAME} refuses pull_request_target, which would run pull-request code with base-repository secrets; run it on pull_request`);
  }
  if (!EVENTS.has(event)) throw new Error(`${ACTION_NAME} runs on pull_request, push, workflow_dispatch and schedule, not ${event || "an unknown event"}`);
  const mode = getInput(environment, "publish");
  if (mode !== "auto" && mode !== "true" && mode !== "false") throw new Error("publish must be auto, true or false");
  // With `auto`, a run publishes where a merge lands and dry-runs everywhere else.
  const publishing = mode === "auto" ? event === "push" || event === "workflow_dispatch" : mode === "true";
  if (event === "pull_request") {
    if (publishing) {
      throw new Error("a pull request never publishes; remove publish: true from this step so it checks the pull request, and publish on push or workflow_dispatch");
    }
    return preview({ environment, payload: readEventPayload(environment) });
  }
  if (!publishing) return publish({ environment, payload: readEventPayload(environment), dryRun: true });
  if (event === "schedule") {
    throw new Error("a scheduled run never publishes; remove publish: true from this step so it dry-runs, and publish on push or workflow_dispatch");
  }
  return publish({ environment, payload: readEventPayload(environment), dryRun: false });
}
