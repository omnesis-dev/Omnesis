// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { RemediationCard } from "./remediation-banner.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function collectText(vnode: any): string {
  if (vnode == null || typeof vnode === "boolean") return "";
  if (Array.isArray(vnode)) return vnode.map(collectText).join("");
  if (typeof vnode === "string" || typeof vnode === "number") return String(vnode);
  if (typeof vnode.type === "function") return collectText(vnode.type(vnode.props));
  return collectText(vnode.props?.children);
}

describe("RemediationCard", () => {
  test("renders the condition on the device, the sources, the steps, the executable and the restart", () => {
    const text = collectText(
      RemediationCard({
        group: {
          deviceId: "dev-a",
          remediation: {
            summary: "Disk access is required",
            steps: [
              "Open the privacy settings pane.",
              "Add the executable.",
            ],
            executable: "/opt/example/bin/node",
            restartRequired: true,
          },
          affectedSourceIds: ["apple-imessage:local", "apple-notes:local"],
        },
        deviceName: "Maya-Laptop",
      }),
    );
    expect(text).toContain("Disk access is required on Maya-Laptop");
    expect(text).toContain("2 sources waiting:");
    expect(text).toContain("Open the privacy settings pane.");
    expect(text).toContain("Add the executable.");
    expect(text).toContain("Restart the collector.");
    expect(text).toContain("/opt/example/bin/node");
  });

  test("omits the executable and the restart when the remedy has neither", () => {
    const text = collectText(
      RemediationCard({
        group: {
          deviceId: "dev-a",
          remediation: {
            summary: "Access is required",
            steps: ["Grant it."],
            restartRequired: false,
          },
          affectedSourceIds: ["vault-notes:operator"],
        },
        deviceName: "Maya-Laptop",
      }),
    );
    expect(text).toContain("1 source waiting:");
    expect(text).not.toContain("Restart the collector");
    expect(text).not.toContain("Executable");
  });
});
