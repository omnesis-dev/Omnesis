// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  CliError,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
  gatewayFetch,
  gatewayJson,
  pickGatewayExitCode,
  withSpinner,
} from "../utils.js";

interface ForgetImpact {
  sources: { id: string; deleteScope: "source" | "partition" | "none" }[];
  fingerprint: string;
}

export function deviceForgetPath(id: string, data: "keep" | "delete", fingerprint: string): string {
  const query = new URLSearchParams({ forget: "true", data, impactFingerprint: fingerprint });
  return `/admin/devices/${encodeURIComponent(id)}?${query}`;
}

/** The history disposition is explicit on the wire and reviewed against current sources. */
export async function forgetDeviceFromCli(
  id: string,
  safeName: string,
  options: { data?: string; yes?: boolean },
): Promise<void> {
  if (options.data !== undefined && options.data !== "keep" && options.data !== "delete") {
    throw new CliError("--data must be keep or delete.", EXIT_USER_ERROR);
  }
  const impact = await withSpinner("Checking device sources", () =>
    gatewayJson<ForgetImpact>(`/admin/devices/${encodeURIComponent(id)}/forget-impact`),
  );
  let data: "keep" | "delete" = options.data ?? "keep";
  if (impact.sources.length > 0 && !options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CliError(
        "This device hosts sources. Re-run with --forget --data keep --yes to keep its history, or --forget --data delete --yes to delete data held only by this device. Shared data still in use and previously kept history stay.",
        EXIT_USER_ERROR,
      );
    }
    const prompts = await import("@clack/prompts");
    if (options.data === undefined) {
      const selected = await prompts.select({
        message: `Forget ${safeName}: what should happen to its source data?`,
        initialValue: "keep",
        options: [
          {
            value: "keep",
            label: "Keep historical data",
            hint: "History stays searchable; syncing and device warnings stop",
          },
          {
            value: "delete",
            label: "Remove this device's data",
            hint: "Shared data and previously kept history stay",
          },
        ],
      });
      if (selected !== "keep" && selected !== "delete")
        throw new CliError("Cancelled.", EXIT_CANCELLED);
      data = selected;
    }
    const confirmed = await prompts.confirm({
      message:
        data === "delete"
          ? `Forget ${safeName} and permanently delete data held only by it? This cannot be undone. Shared data still in use and previously kept history stay.`
          : `Forget ${safeName} and keep its indexed history without syncing this device again?`,
      initialValue: false,
    });
    if (prompts.isCancel(confirmed) || !confirmed) throw new CliError("Cancelled.", EXIT_CANCELLED);
  }
  const response = await withSpinner(`Forgetting ${safeName}`, () =>
    gatewayFetch(deviceForgetPath(id, data, impact.fingerprint), { method: "DELETE" }),
  );
  if (!response.ok) {
    if (response.status === 409) {
      throw new CliError(
        "The device's sources changed. Review them by running the command again.",
        EXIT_USER_ERROR,
      );
    }
    throw new CliError(
      `Failed to forget device: ${response.status}`,
      pickGatewayExitCode(response.status),
    );
  }
  console.log(`Forgot device ${safeName} (${id}).`);
  if (impact.sources.length > 0) {
    console.log(
      data === "keep"
        ? "Its historical data stays searchable. This device will no longer sync or report source errors."
        : "Removal of data held only by this device is queued. Other devices, shared data still in use and previously kept history stay.",
    );
  }
}
