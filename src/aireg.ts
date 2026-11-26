import { spawn } from "node:child_process";
import { type Environment, withoutWorkflowCommands } from "./action.ts";
import {
  MANIFEST_FILE, MAX_ARTIFACT_DEPENDENCIES, MAX_CHANGED_FILES, MAX_CHANGED_PATH_CHARS, MAX_CLI_OUTPUT_BYTES,
  MAX_FIELD_CHARS, MAX_PUBLISHED_ARTIFACTS, MAX_REASON_CHARS, MAX_REGISTRIES,
  MAX_SKIP_REASON_CHARS
} from "./constants.ts";
import { publisherEnvironment, redact, type SubprocessEnvironment, type Tokens } from "./tokens.ts";

export interface Command {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: SubprocessEnvironment;
}

export type Execute = (command: Command) => Promise<string>;

export class AiregRefusal extends Error {
  readonly reason: AiregReason;

  constructor(message: string, reason: AiregReason) {
    super(message);
    this.name = "AiregRefusal";
    this.reason = reason;
  }
}

export class AiregOutputTooLarge extends Error {
  constructor() {
    super("aireg output exceeds the size limit");
    this.name = "AiregOutputTooLarge";
  }
}

/** Runs without a shell and with workflow commands suspended, because aireg echoes pull-request-controlled names.
 *  Oversized output is drained rather than stopped, so a publish never halts halfway. */
export const runAireg: Execute = ({ binary, args, cwd, env }) => withoutWorkflowCommands(() => new Promise<string>((resolve, reject) => {
  const child = spawn(binary, [...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_CLI_OUTPUT_BYTES) chunks.push(chunk);
  });
  child.on("error", reject);
  // "close" waits for stdout to drain; "exit" can fire first and lose its tail.
  child.on("close", (code, signal) => {
    const oversized = size > MAX_CLI_OUTPUT_BYTES;
    const stdout = oversized ? "" : redact(Buffer.concat(chunks).toString("utf8"), env);
    if (code === 0) {
      if (oversized) reject(new AiregOutputTooLarge());
      else resolve(stdout);
      return;
    }
    const ended = code === null ? `was killed by ${signal}` : `exited with status ${code}`;
    const reason = failureReason(stdout, cwd);
    if (!reason) {
      reject(new Error(`aireg ${args[0]} ${ended}`));
      return;
    }
    reject(new AiregRefusal(`aireg ${args[0]} ${ended}: ${reason.message}${reason.hint ? ` Hint: ${reason.hint}` : ""}`, reason));
  });
}));

interface PublishCommand {
  binary: string;
  runtimeDirectory: string;
  cwd: string;
  environment: Environment;
  tokens: Tokens;
  dryRun: boolean;
  execute: Execute;
}

export function runAiregPublish({ binary, runtimeDirectory, cwd, environment, tokens, dryRun, execute }: PublishCommand): Promise<string> {
  return execute({
    binary,
    args: ["publish", "--yes", "--json", ...(dryRun ? ["--dry-run"] : [])],
    cwd,
    env: publisherEnvironment(environment, tokens, runtimeDirectory)
  });
}

export interface Registry {
  registry: string;
  adapter?: string;
  /** The canonical JSON of aireg's whole entry, so any change to it is a different declaration. */
  declaration: string;
}

export interface Changes {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface Artifact {
  name: string;
  kind: string;
  registry: string;
  namespace: string;
  from: string | null;
  version: string;
  digest?: string;
  published: boolean;
  dependsOn: { to: string }[];
  filesChanged?: Changes;
  dependsOnChanged?: Pick<Changes, "added" | "removed">;
  /** The registry's newest version when its status holds it back, such as `blocked`. */
  withheld?: Withheld;
}

export interface Withheld {
  version: string;
  status: string;
  reason?: string;
}

export interface Skip {
  name: string;
  kind: string;
  path?: string;
  reason: string;
}

export interface Target {
  registry: string;
  namespace: string;
}

export interface PublishResult {
  dryRun: boolean;
  target?: Target;
  artifacts: Artifact[];
  skipped: Skip[];
  unread?: boolean;
}

export interface AiregReason {
  code?: string;
  message: string;
  hint?: string;
}

type Json = Record<string, unknown>;

const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const FIELD = new RegExp(`^[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]{1,${MAX_FIELD_CHARS}}$`, "u");
const STORED_PATH = new RegExp(`^[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]{1,${MAX_CHANGED_PATH_CHARS}}$`, "u");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ADAPTER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const REGISTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ERROR_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const isField = (value: unknown): value is string => typeof value === "string" && FIELD.test(value);
const isStoredPath = (value: unknown): value is string => typeof value === "string" && STORED_PATH.test(value);
const prose = (value: string, limit: number): string => value.replace(UNPRINTABLE, " ").trim().slice(0, limit);

/** aireg prints its JSON answer as the last non-empty line. */
function airegAnswer(raw: string): Json | undefined {
  const line = raw.split("\n").map(item => item.trim()).filter(Boolean).at(-1);
  try {
    return object(JSON.parse(line ?? ""));
  } catch {
    return undefined;
  }
}

function okData(raw: string): Json | undefined {
  const answer = airegAnswer(raw);
  return answer?.ok === true ? object(answer.data) : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = object(value);
  if (entries) return `{${Object.keys(entries).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(entries[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function declaredRegistries(raw: string): Registry[] {
  const data = okData(raw);
  const registries = data?.registries;
  const isValid = (entry: unknown): entry is Json & { registry: string; adapter?: string } => {
    const item = object(entry);
    return typeof item?.registry === "string" && REGISTRY_NAME.test(item.registry) &&
      (item.adapter === undefined || (typeof item.adapter === "string" && ADAPTER_ID.test(item.adapter)));
  };
  if (data?.scope !== "project" || !Array.isArray(registries) || registries.length > MAX_REGISTRIES || !registries.every(isValid)) {
    throw new Error(`aireg could not list the registries ${MANIFEST_FILE} declares`);
  }
  return registries.map(entry => ({
    registry: entry.registry,
    ...(entry.adapter === undefined ? {} : { adapter: entry.adapter }),
    declaration: canonicalJson(entry)
  }));
}

/** `null` when absent or empty, `undefined` when malformed. */
function changeLists<K extends string>(value: unknown, keys: readonly K[], isValid: (item: unknown) => boolean, limit: number): Record<K, string[]> | null | undefined {
  if (value === undefined) return null;
  const given = object(value);
  if (!given) return undefined;
  const lists = {} as Record<K, string[]>;
  for (const key of keys) {
    const list = given[key] === undefined ? [] : given[key];
    if (!Array.isArray(list) || list.length > limit || !list.every(isValid)) return undefined;
    lists[key] = list as string[];
  }
  return Object.values<string[]>(lists).some(list => list.length > 0) ? lists : null;
}

function artifact(value: unknown): Artifact | undefined {
  const entry = object(value);
  if (!entry) return undefined;
  const { name, kind, registry, namespace, from, version, digest, published } = entry;
  const dependsOn = entry.dependsOn ?? [];
  if (!isField(name) || !isField(kind) || !isField(registry) || !isField(namespace) || !isField(version) || (from !== null && !isField(from)) ||
      typeof published !== "boolean" || (digest !== undefined && !(typeof digest === "string" && DIGEST.test(digest))) ||
      !Array.isArray(dependsOn) || dependsOn.length > MAX_ARTIFACT_DEPENDENCIES) {
    return undefined;
  }
  const dependencies = dependsOn.map(item => object(item)?.to);
  const filesChanged = changeLists(entry.filesChanged, ["added", "changed", "removed"], isStoredPath, MAX_CHANGED_FILES);
  const dependsOnChanged = changeLists(entry.dependsOnChanged, ["added", "removed"], isField, MAX_ARTIFACT_DEPENDENCIES);
  const held = entry.withheld === undefined ? null : withheld(entry.withheld);
  if (!dependencies.every(isField) || filesChanged === undefined || dependsOnChanged === undefined || held === undefined) return undefined;
  return {
    name, kind, registry, namespace, from, version, ...(digest === undefined ? {} : { digest }), published,
    dependsOn: dependencies.map(to => ({ to })),
    ...(filesChanged ? { filesChanged } : {}), ...(dependsOnChanged ? { dependsOnChanged } : {}),
    ...(held ? { withheld: held } : {})
  };
}

function withheld(value: unknown): Withheld | undefined {
  const entry = object(value);
  if (!isField(entry?.version) || !isField(entry.status) || (entry.reason !== undefined && typeof entry.reason !== "string")) return undefined;
  const reason = entry.reason === undefined ? "" : prose(entry.reason, MAX_SKIP_REASON_CHARS);
  return { version: entry.version, status: entry.status, ...(reason === "" ? {} : { reason }) };
}

function skip(value: unknown): Skip | undefined {
  const entry = object(value);
  if (!isField(entry?.name) || !isField(entry.kind) || typeof entry.reason !== "string" || (entry.path !== undefined && !isField(entry.path))) {
    return undefined;
  }
  return { name: entry.name, kind: entry.kind, ...(entry.path === undefined ? {} : { path: entry.path }), reason: prose(entry.reason, MAX_SKIP_REASON_CHARS) };
}

function target(value: unknown): Target | undefined {
  const entry = object(value);
  return isField(entry?.registry) && isField(entry.namespace) ? { registry: entry.registry, namespace: entry.namespace } : undefined;
}

const namesTarget = (data: Json | undefined): boolean => data?.target !== undefined && data.target !== null;
const isDefined = <T>(item: T | undefined): item is T => item !== undefined;

/** A dry run is evidence for the preview, so anything malformed or over a bound makes the whole answer unreadable. */
export function dryRunResult(raw: string): PublishResult {
  const data = okData(raw);
  const isBounded = (list: unknown): list is unknown[] => Array.isArray(list) && list.length <= MAX_PUBLISHED_ARTIFACTS;
  const artifacts = isBounded(data?.artifacts) ? data.artifacts.map(artifact) : undefined;
  const skipped = data?.skipped === undefined ? [] : isBounded(data.skipped) ? data.skipped.map(skip) : undefined;
  const to = namesTarget(data) ? target(data?.target) : undefined;
  if (data?.dryRun !== true || !artifacts?.every(isDefined) || !skipped?.every(isDefined) || (namesTarget(data) && !to)) {
    throw new Error("aireg returned an unreadable publish result");
  }
  return { dryRun: true, ...(to ? { target: to } : {}), artifacts, skipped };
}

/** A completed publish keeps every entry it can read and marks the rest unread, because the writes already happened. */
export function publishedResult(raw: string): PublishResult {
  const data = okData(raw);
  const read = <T>(list: unknown, parse: (item: unknown) => T | undefined): (T | undefined)[] =>
    Array.isArray(list) ? list.slice(0, MAX_PUBLISHED_ARTIFACTS).map(parse) : [];
  const listed: unknown[] = Array.isArray(data?.artifacts) ? data.artifacts : [];
  const artifacts = read(listed, artifact);
  const skipped = read(data?.skipped, skip);
  const to = target(data?.target);
  const complete = data?.dryRun === false && artifacts.length === listed.length && Array.isArray(data.artifacts) &&
    (data.skipped === undefined || (Array.isArray(data.skipped) && skipped.length === data.skipped.length)) &&
    artifacts.every(isDefined) && skipped.every(isDefined) && (!namesTarget(data) || to !== undefined);
  const withoutChanges = (item: Artifact | undefined, at: number): Artifact | undefined =>
    item ?? artifact({ ...object(listed[at]), digest: undefined, filesChanged: undefined, dependsOnChanged: undefined });
  return {
    dryRun: false,
    ...(to ? { target: to } : {}),
    artifacts: artifacts.map(withoutChanges).filter(isDefined),
    skipped: skipped.filter(isDefined),
    ...(complete ? {} : { unread: true })
  };
}

export function failureReason(stdout: string, cwd: string): AiregReason | undefined {
  const answer = airegAnswer(stdout);
  const error = answer?.ok === false ? object(answer.error) : undefined;
  if (typeof error?.message !== "string") return undefined;
  const local = (text: string) => prose(text, MAX_REASON_CHARS).replaceAll(`${cwd}/`, "");
  return {
    ...(typeof error.code === "string" && ERROR_CODE.test(error.code) ? { code: error.code } : {}),
    message: local(error.message),
    ...(typeof error.hint === "string" && error.hint.trim() ? { hint: local(error.hint) } : {})
  };
}
