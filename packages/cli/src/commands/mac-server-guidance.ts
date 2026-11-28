// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Installing a login service does not configure the Mac's system-sleep policy. */
export function macServerGuidance(platform: NodeJS.Platform, hostsGateway: boolean): string | null {
  if (platform !== "darwin" || !hostsGateway) return null;
  return [
    "Keep this Mac available for your other devices:",
    "  Required gateway setup: prevent automatic system sleep while connected to power.",
    "  A desktop Mac left powered on is a good library host.",
    "  Desktop: System Settings > Energy (Energy Saver on Sonoma) >",
    "    Prevent automatic sleeping when the display is off.",
    "  MacBook: connect power, then Battery > Options >",
    "    Prevent automatic sleeping on power adapter when the display is off.",
    "    Keep the lid open unless using Apple's supported external-display setup.",
    "  Your display can turn off and the screen can stay locked.",
    "  Wake for network access alone does not keep this library connected.",
    "  Steps: https://omnesis.dev/docs/install#mac-server",
  ].join("\n");
}
