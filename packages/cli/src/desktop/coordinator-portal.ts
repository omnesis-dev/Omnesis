// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { continued, desktopAccountSchema, safeBrowserUrl } from "./account-connect.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopProtocolContext } from "./protocol.js";
import type { CoordinatorDependencies } from "./coordinator-runtime.js";
import type { DesktopPairing } from "./enrollment.js";
export async function openDesktopPortal(
  profile: DesktopProfile,
  context: DesktopProtocolContext,
  operations: Pick<CoordinatorDependencies, "readInstall" | "request"> & {
    readPair(): Promise<DesktopPairing | null>;
  },
): Promise<void> {
  const install = await operations.readInstall(profile);
  let origin: string;
  if (install?.mode === "home") {
    const account = desktopAccountSchema.parse(
      await operations.request(profile, "/admin/cloud-relay", { signal: context.signal }),
    );
    if (!account.account?.linked || !account.publicOrigin)
      throw new Error("Connect your account first");
    origin = account.publicOrigin;
  } else {
    const pairing = await operations.readPair();
    if (!pairing) throw new Error("Connect this Mac first");
    origin = pairing.gatewayUrl;
  }
  const base = new URL(safeBrowserUrl(origin));
  if (base.pathname !== "/" || base.search || base.hash) throw new Error("Invalid library origin");
  await context.interactions.ask(
    "openBrowser",
    {
      url: new URL("/portal/", base).href,
      message: "Open the advanced web settings in your browser. You may be asked to sign in.",
    },
    continued,
    context.signal,
  );
}
