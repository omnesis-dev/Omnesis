// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Registry discovery never reads Docker credentials. Private image pulls
 * require credentials available to the actual pull process: the host installer
 * uses its Docker login, while the updater needs an explicitly mounted config. */
const PIN_REMEDY =
  "For a private registry, run docker login on the host and re-run the installer with --version X.Y.Z and the same topology flags. " +
  "The updater does not inherit host Docker credentials; --target-version requires a self-contained Docker config mounted into it.";
const STABLE_TAG = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_TAGS = 10_000;
const MAX_PAGES = 10;
const MAX_RESPONSE_BYTES = 1_048_576;

type Fetch = typeof fetch;

interface RegistryImage {
  origin: string;
  repository: string;
}

function loopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function registryImage(reference: string): RegistryImage {
  if (reference.includes("@")) throw new Error("Digest-pinned images cannot follow release tags.");
  const withoutTag = reference.replace(/:[^/:]+$/, "");
  const segments = withoutTag.split("/");
  let host = "registry-1.docker.io";
  if (segments.length > 1 && /[.:]|^localhost$/.test(segments[0]!)) host = segments.shift()!;
  if (["docker.io", "index.docker.io"].includes(host)) host = "registry-1.docker.io";
  if (host === "registry-1.docker.io" && segments.length === 1) segments.unshift("library");
  const repository = segments.join("/");
  if (
    !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(
      repository,
    )
  ) {
    throw new Error("Compose returned an invalid container repository.");
  }
  const registry = new URL(`https://${host}`);
  if (
    registry.username ||
    registry.password ||
    registry.pathname !== "/" ||
    registry.search ||
    registry.hash
  ) {
    throw new Error("Compose returned an invalid registry host.");
  }
  // Local development registries often have no TLS. Remote registries always do.
  if (loopback(registry.hostname)) registry.protocol = "http:";
  return { origin: registry.origin, repository };
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("Registry returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("Registry response exceeded the discovery limit.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function request(url: URL, fetcher: Fetch, token?: string): Promise<Response> {
  return fetcher(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
}

async function bearerToken(
  response: Response,
  image: RegistryImage,
  fetcher: Fetch,
): Promise<string> {
  const challenge = response.headers.get("www-authenticate") ?? "";
  if (!/^Bearer\s/i.test(challenge)) throw new Error(PIN_REMEDY);
  await response.body?.cancel();
  const params = new Map<string, string>();
  for (const match of challenge.matchAll(/([a-z_]+)="([^"\r\n]*)"/gi)) {
    const name = match[1]!.toLowerCase();
    if (params.has(name))
      throw new Error("Registry supplied an ambiguous authentication challenge.");
    params.set(name, match[2]!);
  }
  const realm = params.get("realm");
  if (!realm) throw new Error("Registry supplied no authentication realm.");
  const url = new URL(realm);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(url.origin === image.origin && loopback(url.hostname)))
  ) {
    throw new Error("Registry authentication requires a secure realm.");
  }
  url.searchParams.set("scope", `repository:${image.repository}:pull`);
  const service = params.get("service");
  if (service) url.searchParams.set("service", service);
  const result = await request(url, fetcher);
  if (!result.ok) throw new Error(PIN_REMEDY);
  const body = (await boundedJson(result, 65_536)) as { token?: unknown; access_token?: unknown };
  const token = body && typeof body === "object" ? (body.token ?? body.access_token) : undefined;
  if (typeof token !== "string" || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    throw new Error("Registry supplied no usable anonymous token.");
  }
  return token;
}

function nextPage(response: Response, current: URL): URL | undefined {
  const links = response.headers.get("link");
  if (!links) return undefined;
  const matches = [...links.matchAll(/<([^>]+)>\s*;\s*rel="?next"?(?=\s*[,;]|\s*$)/gi)];
  if (!matches.length && /rel\s*=\s*"?next/i.test(links))
    throw new Error("Invalid registry pagination.");
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw new Error("Ambiguous registry pagination.");
  const next = new URL(matches[0]![1]!, current);
  if (
    next.origin !== current.origin ||
    next.pathname !== current.pathname ||
    next.username ||
    next.password ||
    next.hash
  ) {
    throw new Error("Registry pagination left its repository.");
  }
  return next;
}

async function stableTags(image: RegistryImage, fetcher: Fetch): Promise<Set<string>> {
  let url: URL | undefined = new URL(`/v2/${image.repository}/tags/list?n=1000`, image.origin);
  let token: string | undefined;
  const seen = new Set<string>();
  const tags = new Set<string>();
  let tagCount = 0;
  while (url) {
    if (seen.has(url.href) || seen.size >= MAX_PAGES)
      throw new Error("Registry pagination exceeded the discovery limit.");
    seen.add(url.href);
    let response = await request(url, fetcher, token);
    if (response.status === 401 && !token) {
      token = await bearerToken(response, image, fetcher);
      response = await request(url, fetcher, token);
    }
    if ([401, 403].includes(response.status)) throw new Error(PIN_REMEDY);
    if (!response.ok) throw new Error(`Container registry answered HTTP ${response.status}.`);
    const body = (await boundedJson(response, MAX_RESPONSE_BYTES)) as {
      name?: unknown;
      tags?: unknown;
    };
    if (
      !body ||
      typeof body !== "object" ||
      (body.name !== undefined && body.name !== image.repository) ||
      !Array.isArray(body.tags) ||
      body.tags.some((tag) => typeof tag !== "string")
    ) {
      throw new Error("Registry returned an invalid tag list.");
    }
    tagCount += body.tags.length;
    if (tagCount > MAX_TAGS) throw new Error("Registry tag count exceeded the discovery limit.");
    for (const tag of body.tags as string[])
      if (tag.length <= 128 && STABLE_TAG.test(tag)) tags.add(tag);
    url = nextPage(response, url);
  }
  return tags;
}

/** Only image tags controlled by this installation's release selector move
 * together. Independently versioned sidecars (for example Tailscale) do not. */
export function dockerReleaseImages(rawJson: string, renderedJson: string): string[] {
  if (rawJson.length > MAX_RESPONSE_BYTES || renderedJson.length > MAX_RESPONSE_BYTES) {
    throw new Error("Compose configuration exceeded the discovery limit.");
  }
  const raw = JSON.parse(rawJson) as { services?: Record<string, { image?: unknown }> };
  const rendered = JSON.parse(renderedJson) as { services?: Record<string, { image?: unknown }> };
  if (!raw?.services || !rendered?.services)
    throw new Error("Compose returned no service configuration.");
  const images: string[] = [];
  const releaseTag = /\$\{OMNESIS_IMAGE_TAG(?::[-+?][^}]*)?\}|\$OMNESIS_IMAGE_TAG(?![A-Za-z0-9_])/;
  for (const [name, service] of Object.entries(raw.services)) {
    if (!service || typeof service.image !== "string" || !releaseTag.test(service.image)) continue;
    const image = rendered.services[name]?.image;
    if (typeof image !== "string" || !image)
      throw new Error("Compose did not resolve a release image.");
    images.push(image);
  }
  if (!images.length)
    throw new Error(
      "The Compose project has no images referencing OMNESIS_IMAGE_TAG; repair the installation before updating.",
    );
  return images;
}

/** Highest stable version present in every image in the actual Compose project,
 * including its one-shot updater. Discovery finishes before selecting a tag. */
export async function newestCommonDockerTag(
  imageReferences: readonly string[],
  fetcher: Fetch = fetch,
): Promise<string> {
  if (!imageReferences.length || imageReferences.length > 100)
    throw new Error("Compose returned no usable image set.");
  const images = new Map<string, RegistryImage>();
  for (const reference of imageReferences) {
    const image = registryImage(reference);
    images.set(`${image.origin}/${image.repository}`, image);
  }
  let common: Set<string> | undefined;
  for (const image of images.values()) {
    const tags = await stableTags(image, fetcher);
    common = new Set(common ? [...common].filter((tag) => tags.has(tag)) : tags);
  }
  const sorted = [...common!].sort((a, b) => {
    const left = a.split(".").map(BigInt);
    const right = b.split(".").map(BigInt);
    for (let i = 0; i < 3; i++) {
      if (left[i]! > right[i]!) return 1;
      if (left[i]! < right[i]!) return -1;
    }
    return 0;
  });
  const newest = sorted.at(-1);
  if (!newest)
    throw new Error(
      "No stable X.Y.Z tag is shared by every Compose image. Use --target-version X.Y.Z after verifying publication finished.",
    );
  return newest;
}
