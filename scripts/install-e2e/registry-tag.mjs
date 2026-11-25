#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
/**
 * The newest release every one of a set of published images carries, the
 * choice the installer makes when it is given no version.
 *
 *   node scripts/install-e2e/registry-tag.mjs <registry host> <namespace> <image>...
 *
 * Prints the tag (X.Y.Z). Reads each image's tag list anonymously, with the
 * pull token the registry's challenge offers, following its pagination.
 */
import { isEntryScript } from "../lib/is-entry-script.mjs";
import { compareVersions } from "./fixture.mjs";

const STABLE = /^\d+\.\d+\.\d+$/u;
const MAX_PAGES = 10;

/** The newest X.Y.Z tag present in every list, or null. */
export function newestCommonTag(tagLists) {
  const [first = [], ...rest] = tagLists.map((tags) => new Set(tags.filter((t) => STABLE.test(t))));
  return (
    [...first]
      .filter((tag) => rest.every((tags) => tags.has(tag)))
      .sort(compareVersions)
      .at(-1) ?? null
  );
}

/** The next page a registry's `Link` header names, resolved against `url`, or null. */
export function nextPage(link, url) {
  const match = /<([^>]+)>\s*;\s*rel="?next"?/iu.exec(link ?? "");
  return match ? new URL(match[1], url).href : null;
}

async function tagsOf(host, repository) {
  const token = await fetch(`https://${host}/token?scope=repository:${repository}:pull`)
    .then((response) => {
      if (!response.ok)
        throw new Error(`${host} refused a pull token for ${repository}: HTTP ${response.status}`);
      return response.json();
    })
    .then((body) => body.token);
  const tags = [];
  let url = `https://${host}/v2/${repository}/tags/list?n=1000`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok)
      throw new Error(`${host} did not list the tags of ${repository}: HTTP ${response.status}`);
    tags.push(...((await response.json()).tags ?? []));
    url = nextPage(response.headers.get("link"), url);
  }
  return tags;
}

async function main([host, namespace, ...images]) {
  if (!host || !namespace || images.length === 0)
    throw new Error("usage: registry-tag.mjs <registry host> <namespace> <image>...");
  const tag = newestCommonTag(
    await Promise.all(images.map((image) => tagsOf(host, `${namespace}/${image}`))),
  );
  if (!tag)
    throw new Error(`no X.Y.Z tag is common to ${images.join(", ")} on ${host}/${namespace}`);
  process.stdout.write(`${tag}\n`);
}

if (isEntryScript(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    // fetch reports a lookup or connection failure as "fetch failed", with the
    // reason in its cause.
    const cause = err instanceof Error && err.cause ? ` (${err.cause.message ?? err.cause})` : "";
    process.stderr.write(
      `registry-tag: ${err instanceof Error ? err.message : String(err)}${cause}\n`,
    );
    process.exit(1);
  });
}
