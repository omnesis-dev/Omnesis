// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { MemberPickerModal } from "./member-picker-modal.js";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { memberDetachBody } from "../views/sources.js";

let host: HTMLElement;
const device = { id: "device-a", name: "example phone", kind: "ios" };
const onConfirm = vi.fn();
const onCancel = vi.fn();

beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = document.querySelector("main")!;
  vi.clearAllMocks();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

async function show(devices = [device], mode = "partitioned") {
  await act(async () =>
    render(
      h(MemberPickerModal, {
        title: "Detach a device",
        devices,
        body: (d: typeof device) =>
          memberDetachBody({ id: "observations:local", multiDeviceMode: mode }, d),
        confirmLabel: "Detach and delete device data",
        destructive: true,
        onConfirm,
        onCancel,
      }),
      host,
    ),
  );
}

test("destructive detach explains scope and cancellation does not submit", async () => {
  await show();
  expect(host.textContent).toContain("Delete example phone's managed gateway contribution");
  expect(host.textContent).toContain("last member cannot detach");
  await act(async () => {
    (host.querySelector(".btn-ghost") as HTMLElement).dispatchEvent(new window.Event("click"));
  });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});

test("a selected member disappearing disables confirmation", async () => {
  await show();
  await show([]);
  expect((host.querySelector(".btn-primary") as HTMLButtonElement).disabled).toBe(true);
  expect(host.textContent).toContain("No eligible device");
  expect(onConfirm).not.toHaveBeenCalled();
});

test("shared detach warns about a changed mode and submits only after confirmation", async () => {
  await show([device], "replicated");
  expect(host.textContent).toContain("Shared indexed data stays");
  expect(host.textContent).toContain(
    "if the source is partitioned when the gateway handles the request",
  );
  expect(onConfirm).not.toHaveBeenCalled();
  await act(async () => {
    (host.querySelector(".btn-primary") as HTMLElement).dispatchEvent(new window.Event("click"));
  });
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(device.id);
});
