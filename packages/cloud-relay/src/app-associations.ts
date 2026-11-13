// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { RelayError } from "./tunnels.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const configuration = z
  .object({
    apple: z
      .array(
        z
          .string()
          .regex(/^[A-Z0-9]{10}\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/)
          .max(255),
      )
      .max(16)
      .default([]),
    android: z
      .array(
        z
          .object({
            packageName: z
              .string()
              .regex(/^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)+$/)
              .max(255),
            sha256: z
              .array(z.string().regex(/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/))
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .max(16)
      .default([]),
  })
  .strict();

/**
 * Google Play services validates a passkey's relying party ID against this statement. Its
 * Credential Manager guide declares both relations; the apps declare no auto-verified App Links,
 * so handle_all_urls opens no web URLs in them.
 */
const ANDROID_RELATIONS = [
  "delegate_permission/common.handle_all_urls",
  "delegate_permission/common.get_login_creds",
];

/** Platform associations authorize only configured applications and signing certificates to use account passkeys. */
export class AppAssociations {
  private readonly apple: readonly string[];
  private readonly android: readonly { packageName: string; sha256: readonly string[] }[];
  constructor(input: unknown) {
    const value = configuration.parse(input);
    if (
      new Set(value.apple).size !== value.apple.length ||
      new Set(value.android.map((app) => app.packageName)).size !== value.android.length
    )
      throw new Error("Duplicate associated application");
    this.apple = value.apple;
    this.android = value.android.map((app) => ({
      packageName: app.packageName,
      sha256: [...new Set(app.sha256.map((hash) => hash.toUpperCase()))],
    }));
  }

  androidOrigins(): string[] {
    return [
      ...new Set(
        this.android.flatMap((app) =>
          app.sha256.map(
            (hash) =>
              `android:apk-key-hash:${Buffer.from(hash.replaceAll(":", ""), "hex").toString("base64url")}`,
          ),
        ),
      ),
    ];
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = req.url?.split("?")[0];
    if (
      path !== "/.well-known/apple-app-site-association" &&
      path !== "/.well-known/assetlinks.json"
    )
      return false;
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
    if (req.url !== path)
      throw new RelayError(400, "Application association does not accept query parameters");
    const value =
      path === "/.well-known/apple-app-site-association"
        ? { webcredentials: { apps: this.apple } }
        : this.android.map((app) => ({
            relation: ANDROID_RELATIONS,
            target: {
              namespace: "android_app",
              package_name: app.packageName,
              sha256_cert_fingerprints: app.sha256,
            },
          }));
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    });
    res.end(JSON.stringify(value));
    return true;
  }
}
