// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Install-method-specific release lookups for the passive gateway check.
 *
 * Every remote answer is bounded and treated as untrusted. Callers own the
 * overall deadline through `signal`; any error is deliberately handled by the
 * state service, where a failed check changes nothing and emits nothing.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { assertNever } from "@omnesis/core";
import {
  compareStableReleaseVersions,
  isStableReleaseVersion,
  newestStableTag,
  packageIndexUrl,
  versionFromStableTag,
  type InstallMethod,
} from "@omnesis/core/release-check";

const PACKAGE_BODY_LIMIT = 256 * 1024;
const REGISTRY_BODY_LIMIT = 1024 * 1024;
const TOKEN_BODY_LIMIT = 64 * 1024;
const GIT_OUTPUT_LIMIT = 1024 * 1024;
const MAX_REGISTRY_PAGES = 10;
const MAX_REGISTRY_TAGS = 10_000;
const MAX_REGISTRY_TAG_BYTES = 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/u;
const IMAGE_COMPONENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const OMNESIS_IMAGES = new Set(["omnesis-gateway", "omnesis-collector", "omnesis-updater"]);

export interface ReleaseLookupDeps {
  runGit?: (rootDir: string, signal: AbortSignal) => Promise<string>;
  fetchFn?: typeof fetch;
  readCompose?: (path: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

function runGitLsRemote(rootDir: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", "--tags", "--refs", "origin", "refs/tags/v*"],
      {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
        signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function boundedResponseText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > limit) {
    await response.body?.cancel();
    throw new Error("remote response exceeded its size limit");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error("remote response exceeded its size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  return JSON.parse(await boundedResponseText(response, limit)) as unknown;
}

async function lookupPackageLatest(
  deps: ReleaseLookupDeps,
  signal: AbortSignal,
): Promise<string | null> {
  const url = packageIndexUrl("latest", deps.env);
  const response = await (deps.fetchFn ?? fetch)(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`package index answered HTTP ${response.status}`);
  }
  const body = await boundedJson(response, PACKAGE_BODY_LIMIT);
  if (typeof body !== "object" || body === null || !("version" in body)) return null;
  const version = (body as { version?: unknown }).version;
  return isStableReleaseVersion(version) ? version : null;
}

function unquoteImageValue(line: string): string | null {
  const match = line.match(/^\s*image:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/u);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function imageRepository(image: string): string | null {
  if (!image || image.includes("@") || /\s/u.test(image)) return null;
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  const repository = colon > slash ? image.slice(0, colon) : image;
  const leaf = repository.slice(repository.lastIndexOf("/") + 1);
  return OMNESIS_IMAGES.has(leaf) ? repository : null;
}

/**
 * Image repositories from the installer-managed Compose dialect. A gateway
 * and updater are both required: without either, this host cannot use the
 * Docker update path the notice would offer.
 */
export function dockerReleaseRepositories(compose: string): string[] {
  const repositories = new Set<string>();
  for (const line of compose.split(/\r?\n/u)) {
    const value = unquoteImageValue(line);
    const repository = value ? imageRepository(value) : null;
    if (repository) repositories.add(repository);
  }
  const leaves = new Set([...repositories].map((value) => value.slice(value.lastIndexOf("/") + 1)));
  if (!leaves.has("omnesis-gateway") || !leaves.has("omnesis-updater")) return [];
  return [...repositories];
}

interface OciRepository {
  origin: string;
  repository: string;
}

function isLoopbackRegistry(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseOciRepository(reference: string): OciRepository | null {
  const parts = reference.split("/");
  if (parts.some((part) => !part)) return null;
  const first = parts[0]!;
  const explicitRegistry = first === "localhost" || first.includes(".") || first.includes(":");
  let registry = explicitRegistry ? first : "docker.io";
  let repositoryParts = explicitRegistry ? parts.slice(1) : parts;
  if (repositoryParts.length === 0) return null;
  if (!explicitRegistry && repositoryParts.length === 1) {
    repositoryParts = ["library", ...repositoryParts];
  }
  if (!repositoryParts.every((part) => IMAGE_COMPONENT_PATTERN.test(part))) return null;

  if (registry === "docker.io" || registry === "index.docker.io") {
    registry = "registry-1.docker.io";
  }
  const scheme = isLoopbackRegistry(registry.replace(/:\d+$/u, "")) ? "http" : "https";
  try {
    const origin = new URL(`${scheme}://${registry}`);
    if (origin.username || origin.password || origin.pathname !== "/") return null;
    return { origin: origin.origin, repository: repositoryParts.join("/") };
  } catch {
    return null;
  }
}

function splitAuthParameters(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (quoted && character === "\\") {
      current += character;
      escaped = true;
    } else if (character === '"') {
      current += character;
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts;
}

function bearerParameters(header: string | null): Record<string, string> | null {
  if (!header) return null;
  const bearer = /(?:^|,)\s*Bearer\s+/iu.exec(header);
  if (!bearer) return null;
  const output: Record<string, string> = {};
  for (const raw of splitAuthParameters(header.slice(bearer.index + bearer[0].length))) {
    const match = raw.trim().match(/^([A-Za-z][A-Za-z0-9._~-]*)\s*=\s*"((?:[^"\\]|\\.)*)"$/u);
    if (!match) continue;
    output[match[1]!.toLowerCase()] = match[2]!.replace(/\\(["\\])/gu, "$1");
  }
  return output;
}

const CROSS_ORIGIN_TOKEN_REALMS = new Map([
  ["https://registry-1.docker.io", "https://auth.docker.io"],
  ["https://registry.gitlab.com", "https://gitlab.com"],
]);

function allowedTokenRealm(url: URL, repository: OciRepository): boolean {
  if (url.username || url.password || url.hash) return false;
  if (url.origin === repository.origin) {
    return (
      url.protocol === "https:" || (url.protocol === "http:" && isLoopbackRegistry(url.hostname))
    );
  }
  return (
    url.protocol === "https:" && CROSS_ORIGIN_TOKEN_REALMS.get(repository.origin) === url.origin
  );
}

async function registryToken(
  challenge: string | null,
  repository: OciRepository,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const params = bearerParameters(challenge);
  if (!params?.realm) throw new Error("registry did not provide a Bearer realm");
  const realm = new URL(params.realm);
  if (!allowedTokenRealm(realm, repository)) {
    throw new Error("registry provided an unsafe Bearer realm");
  }
  if (params.service) realm.searchParams.set("service", params.service);
  realm.searchParams.set("scope", `repository:${repository.repository}:pull`);
  const response = await fetchFn(realm, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`registry token endpoint answered HTTP ${response.status}`);
  }
  const body = await boundedJson(response, TOKEN_BODY_LIMIT);
  if (typeof body !== "object" || body === null) throw new Error("registry returned no token");
  const candidate =
    (body as { token?: unknown; access_token?: unknown }).token ??
    (body as { access_token?: unknown }).access_token;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 16_384 ||
    !TOKEN_PATTERN.test(candidate)
  ) {
    throw new Error("registry returned no usable token");
  }
  return candidate;
}

async function registryPage(
  url: URL,
  repository: OciRepository,
  token: string | null,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ response: Response; token: string | null }> {
  const request = (authorization: string | null) =>
    fetchFn(url, {
      headers: {
        Accept: "application/json",
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
      },
      redirect: "error",
      signal,
    });

  let response = await request(token);
  if (response.status === 401 && token === null) {
    const challenge = response.headers.get("www-authenticate");
    await response.body?.cancel();
    token = await registryToken(challenge, repository, fetchFn, signal);
    response = await request(token);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`registry answered HTTP ${response.status}`);
  }
  return { response, token };
}

function nextRegistryPage(header: string | null, current: URL, tagsPath: string): URL | null {
  if (!header) return null;
  const match = /<([^>]+)>\s*;[^,]*\brel\s*=\s*"?next"?/iu.exec(header);
  if (!match) {
    if (/\brel\s*=\s*"?next"?/iu.test(header)) throw new Error("malformed registry next link");
    return null;
  }
  const next = new URL(match[1]!, current);
  if (
    next.origin !== current.origin ||
    next.pathname !== tagsPath ||
    next.username ||
    next.password ||
    next.hash
  ) {
    throw new Error("registry next link left the tags endpoint");
  }
  return next;
}

/** List strict stable tags for one OCI repository, including bounded pagination. */
export async function listOciStableTags(
  reference: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<Set<string>> {
  const repository = parseOciRepository(reference);
  if (!repository) throw new Error("invalid OCI repository");
  const tagsPath = `/v2/${repository.repository}/tags/list`;
  let url = new URL(tagsPath, repository.origin);
  url.searchParams.set("n", "1000");
  const seen = new Set<string>();
  const tags = new Set<string>();
  let tagCount = 0;
  let tagBytes = 0;
  let token: string | null = null;

  for (let page = 0; page < MAX_REGISTRY_PAGES; page += 1) {
    if (seen.has(url.href)) throw new Error("registry repeated a page");
    seen.add(url.href);
    const result = await registryPage(url, repository, token, fetchFn, signal);
    token = result.token;
    const body = await boundedJson(result.response, REGISTRY_BODY_LIMIT);
    if (typeof body !== "object" || body === null) throw new Error("invalid registry response");
    const values = (body as { tags?: unknown }).tags;
    if (values !== null && !Array.isArray(values)) throw new Error("invalid registry tag list");
    for (const value of values ?? []) {
      if (typeof value !== "string") throw new Error("invalid registry tag");
      tagCount += 1;
      tagBytes += Buffer.byteLength(value);
      if (tagCount > MAX_REGISTRY_TAGS) throw new Error("registry returned too many tags");
      if (tagBytes > MAX_REGISTRY_TAG_BYTES) throw new Error("registry tag list was too large");
      if (isStableReleaseVersion(value)) tags.add(value);
    }
    const next = nextRegistryPage(result.response.headers.get("link"), url, tagsPath);
    if (!next) return tags;
    url = next;
  }
  throw new Error("registry tag pagination exceeded its limit");
}

async function lookupDockerLatest(
  composeFile: string,
  deps: ReleaseLookupDeps,
  signal: AbortSignal,
): Promise<string | null> {
  const compose = await (deps.readCompose ?? ((path) => readFile(path, "utf8")))(composeFile);
  const repositories = dockerReleaseRepositories(compose);
  if (repositories.length === 0) return null;
  const fetchFn = deps.fetchFn ?? fetch;
  const available = await Promise.all(
    repositories.map((repository) => listOciStableTags(repository, fetchFn, signal)),
  );
  const common = new Set(available[0]);
  for (const tags of available.slice(1)) {
    for (const tag of common) if (!tags.has(tag)) common.delete(tag);
  }
  let latest: string | null = null;
  for (const tag of common) {
    if (latest === null || compareStableReleaseVersions(tag, latest) === 1) latest = tag;
  }
  return latest;
}

/** Resolve the newest stable release available through this install's own channel. */
export async function lookupLatestRelease(
  install: InstallMethod,
  deps: ReleaseLookupDeps,
  signal: AbortSignal,
): Promise<string | null> {
  switch (install.method) {
    case "source": {
      const output = await (deps.runGit ?? runGitLsRemote)(install.rootDir, signal);
      const tag = newestStableTag(output);
      return tag ? versionFromStableTag(tag) : null;
    }
    case "npm-global":
      return lookupPackageLatest(deps, signal);
    case "docker":
      return lookupDockerLatest(install.composeFile, deps, signal);
    case "unknown":
      return null;
    default:
      return assertNever(install);
  }
}
