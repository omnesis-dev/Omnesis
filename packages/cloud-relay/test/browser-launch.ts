// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opens a relay sign-in link the way a browser does: the link's page, then its Continue press. A
 * page that isn't the Continue page (an error, the "opened in another browser" page, or a redirect
 * for the browser that already holds the operation) is returned as it is.
 */
export async function openLaunch(link: string, origin: string, cookie = ""): Promise<Response> {
  const target = new URL(link),
    headers: Record<string, string> = cookie ? { cookie } : {};
  const page = await fetch(link, { redirect: "manual", headers });
  if (page.status !== 200) return page;
  await page.text();
  return fetch(target.origin + target.pathname, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, origin, "content-type": "application/x-www-form-urlencoded" },
    body: target.searchParams.toString(),
  });
}
