import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import fsp from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { Environment } from "./action.ts";
import { declaredRegistries, type Execute, type Registry, runAireg } from "./aireg.ts";
import {
  BUILT_IN_ADAPTERS, CLI_ARTIFACT_PATH, CLI_DOWNLOAD_TIMEOUT_MS, CLI_MANIFEST_PATH, CLI_ORIGIN, CLI_RELEASE_KEYS,
  MANIFEST_FILE, MAX_CLI_BYTES, MAX_CLI_MANIFEST_BYTES, MINIMUM_CLI_VERSION, RUNTIME_PREFIX, USER_AGENT
} from "./constants.ts";
import { installEnvironment, listingEnvironment } from "./tokens.ts";

const CLI_OS: Readonly<Record<string, string>> = { linux: "linux", darwin: "darwin" };
const CLI_ARCH: Readonly<Record<string, string>> = { x64: "amd64", arm64: "arm64" };
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANIFEST_KEYS = ["schema", "adapter", "channel", "version", "minimum_version", "published_at", "artifacts", "signatures"];

export function resolveCliPlatform(platform: string, arch: string): string {
  const system = Object.hasOwn(CLI_OS, platform) ? CLI_OS[platform] : undefined;
  if (!system) throw new Error("aireg runs on Linux and macOS runners here; use ubuntu-latest or macos-latest");
  const machine = Object.hasOwn(CLI_ARCH, arch) ? CLI_ARCH[arch] : undefined;
  if (!machine) throw new Error("aireg runs on amd64 and arm64 runners only");
  return `${system}-${machine}`;
}

export type HttpsGet = (url: string, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
  on(event: "timeout", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  destroy(error: Error): unknown;
};

/** Reads one file from the fixed release origin, refusing redirects and any body over `maxBytes`. */
export function fetchRelease(pathname: string, maxBytes: number, get: HttpsGet = https.get): Promise<Buffer> {
  const url = new URL(pathname, CLI_ORIGIN);
  if (url.origin !== CLI_ORIGIN || url.search || url.hash) throw new Error("aireg release URL is not approved");
  return new Promise((resolve, reject) => {
    const request = get(url.href, { timeout: CLI_DOWNLOAD_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } }, response => {
      const status = response.statusCode ?? 0;
      const refusal = status >= 300 && status < 400 ? "aireg download redirected; refusing an unapproved source"
        : status !== 200 ? `aireg download failed with HTTP ${status}`
          : Number(response.headers["content-length"] ?? 0) > maxBytes ? "aireg download exceeds the size limit" : undefined;
      if (refusal) {
        response.resume();
        reject(new Error(refusal));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error("aireg download exceeds the size limit"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.on("timeout", () => request.destroy(new Error("aireg download timed out")));
    request.on("error", reject);
  });
}

interface ReleaseArtifact {
  name: string;
  sha256: string;
  size: number;
}

export interface Release {
  version: string;
  artifacts: ReleaseArtifact[];
}

type Manifest = Record<string, unknown> & { artifacts: ReleaseArtifact[]; signatures: { algorithm?: unknown; key_id?: unknown; value?: unknown }[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isArtifact(value: unknown): value is ReleaseArtifact {
  return isRecord(value) && typeof value.name === "string" && ARTIFACT_NAME.test(value.name) && typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_CLI_BYTES;
}

function parseManifest(raw: Buffer): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("aireg's release manifest is not valid JSON");
  }
  const valid = isRecord(parsed) && Object.keys(parsed).every(key => MANIFEST_KEYS.includes(key)) &&
    parsed.schema === "aireg-manifest.v1" && parsed.adapter === undefined && parsed.channel === "stable" &&
    typeof parsed.version === "string" && VERSION.test(parsed.version) && typeof parsed.published_at === "string" &&
    (parsed.minimum_version === undefined || parsed.minimum_version === null || typeof parsed.minimum_version === "string") &&
    Array.isArray(parsed.artifacts) && parsed.artifacts.length > 0 && parsed.artifacts.every(isArtifact) &&
    Array.isArray(parsed.signatures) && parsed.signatures.length > 0 && parsed.signatures.every(isRecord);
  if (!valid) throw new Error("aireg's release manifest is malformed");
  return parsed as Manifest;
}

/** The bytes aireg's release signatures cover, rebuilt from the parsed fields as aireg builds them. */
function signedPayload(manifest: Manifest): Buffer {
  return Buffer.from(JSON.stringify({
    schema: manifest.schema,
    channel: manifest.channel,
    version: manifest.version,
    minimum_version: manifest.minimum_version ?? null,
    published_at: manifest.published_at,
    artifacts: manifest.artifacts.map(({ name, sha256, size }) => ({ name, sha256, size }))
  }));
}

/** A prerelease sorts before its release. */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const [core = "", pre] = version.split("-", 2);
    return { parts: core.split(".").map(Number), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let at = 0; at < 3; at += 1) {
    const difference = (a.parts[at] ?? 0) - (b.parts[at] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** The stable release, once a pinned key has signed it; a bad signature from a pinned key is never outweighed by a good one. */
export function verifyRelease(raw: Buffer, keys: Readonly<Record<string, string>> = CLI_RELEASE_KEYS, minimum = MINIMUM_CLI_VERSION): Release {
  const manifest = parseManifest(raw);
  const payload = signedPayload(manifest);
  let trusted = false;
  for (const signature of manifest.signatures) {
    const key = typeof signature.key_id === "string" && Object.hasOwn(keys, signature.key_id) ? keys[signature.key_id] : undefined;
    if (key === undefined) continue;
    const value = typeof signature.value === "string" ? Buffer.from(signature.value, "base64") : Buffer.alloc(0);
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key, "base64").toString("base64url") }, format: "jwk" });
    if (signature.algorithm !== "ed25519" || value.length !== 64 || !verify(null, payload, publicKey, value)) {
      throw new Error("aireg's release manifest has an invalid signature");
    }
    trusted = true;
  }
  if (!trusted) throw new Error("aireg's release manifest is not signed by a key this action trusts");
  const version = manifest.version as string;
  if (compareVersions(version, minimum) < 0) {
    throw new Error(`aireg's release manifest names ${version}, older than ${minimum}, the oldest this action runs; refusing a possible rollback`);
  }
  return { version, artifacts: manifest.artifacts };
}

/** The platform's binary, held to the exact size and SHA-256 the signed manifest states. */
export async function downloadCli(release: Release, target: string, get?: HttpsGet): Promise<Buffer> {
  const artifact = release.artifacts.find(item => item.name === `aireg-${target}`);
  if (!artifact) throw new Error(`aireg ${release.version} has no build for ${target}`);
  const binary = await fetchRelease(`${CLI_ARTIFACT_PATH}${release.version}/${artifact.name}`, artifact.size, get);
  const digest = createHash("sha256").update(binary).digest();
  if (binary.length !== artifact.size || !timingSafeEqual(digest, Buffer.from(artifact.sha256, "hex"))) {
    throw new Error("aireg download does not match its signed release manifest");
  }
  return binary;
}

function adaptersToInstall(registries: readonly Registry[]): string[] {
  const adapters = registries.map(entry => entry.adapter).filter((adapter): adapter is string => adapter !== undefined);
  return [...new Set(adapters.filter(adapter => !BUILT_IN_ADAPTERS.includes(adapter)))];
}

interface Installed {
  binary: string;
  /** The caller removes it. */
  directory: string;
  version: string;
  registries: Registry[];
  base?: { registries: Registry[] } | { error: string };
}

export interface InstallOptions {
  environment: Environment;
  cwd: string;
  baseCwd?: string;
  release?: () => Promise<Release>;
  download?: (release: Release, target: string) => Promise<Buffer>;
  execute?: Execute;
}

export type Install = (options: InstallOptions) => Promise<Installed>;

const latestRelease = async (): Promise<Release> => verifyRelease(await fetchRelease(CLI_MANIFEST_PATH, MAX_CLI_MANIFEST_BYTES));

/** Installs the latest signed aireg and the manifest's adapters, none with a credential; failures remove the runtime directory. */
export const installCli: Install = async ({ environment, cwd, baseCwd, release = latestRelease, download = downloadCli, execute = runAireg }) => {
  const target = resolveCliPlatform(process.platform, process.arch);
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), RUNTIME_PREFIX)));
  const binary = path.join(directory, "aireg");
  try {
    const latest = await release();
    await fsp.writeFile(binary, await download(latest, target), { mode: 0o700 });
    const list = (at: string) => execute({ binary, args: ["registry", "list", "--json"], cwd: at, env: listingEnvironment(environment, directory) });
    const registries = declaredRegistries(await list(cwd));
    let base: Installed["base"];
    if (baseCwd !== undefined) {
      try {
        base = { registries: declaredRegistries(await list(baseCwd)) };
      } catch {
        base = { error: `aireg could not list the registries the base commit's ${MANIFEST_FILE} declares` };
      }
    }
    const baseRegistries = base && "registries" in base ? base.registries : [];
    const env = installEnvironment(environment, directory);
    for (const adapter of adaptersToInstall([...registries, ...baseRegistries])) {
      await execute({ binary, args: ["adapter", "install", adapter, "--yes", "--json"], cwd: directory, env });
    }
    return { binary, directory, version: latest.version, registries, ...(base ? { base } : {}) };
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  }
};
