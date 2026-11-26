// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({
  getRecordingRestoreReview: vi.fn(),
  mayRequestRecordingReview: vi.fn(),
  resumeRecordingRestoreReview: vi.fn(),
}));
vi.mock("../lib/recording-restore-review-api.js", () => api);
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../lib/router.js", () => router);
// @ts-expect-error — portal modules are plain JS.
import { RecordingRestoreReview } from "./recording-restore-review.js";
const choices = {
  reviewRequired: true,
  hasPendingChunks: false,
  keepAudioDays: 0,
  transcriberAssignment: null,
  speakers: "local",
  version: "a".repeat(64),
};
let host: HTMLElement;
beforeEach(() => {
  vi.resetAllMocks();
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", parsed.window);
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("Event", parsed.window.Event);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.mayRequestRecordingReview.mockReturnValue(true);
  api.getRecordingRestoreReview.mockResolvedValue(choices);
  api.resumeRecordingRestoreReview.mockResolvedValue({ ...choices, reviewRequired: false });
});
afterEach(() => {
  render(null, host);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => {});
}
async function mount(variant = "settings") {
  await act(async () => {
    render(h(RecordingRestoreReview, { variant }), host);
  });
  await settle();
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  )!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await settle();
}
async function confirm() {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    input.checked = true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

test("Lab-off notice exposes existing work review, not capture or feature activation", async () => {
  await mount("notice");
  expect(host.textContent).toContain("Restored recordings are paused");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/portal/settings/storage");
  expect(host.textContent).not.toMatch(/turn on|capture|record a conversation|omnesis lab/i);
  expect(api.resumeRecordingRestoreReview).not.toHaveBeenCalled();
});

test("known nonadmin never queries or discloses the review metadata", async () => {
  api.mayRequestRecordingReview.mockReturnValue(false);
  await mount("notice");
  expect(api.getRecordingRestoreReview).not.toHaveBeenCalled();
  expect(host.textContent).toBe("");
});

test("current choices show zero-day risk, None model and possible local downloads before explicit confirmation", async () => {
  await mount();
  await click("Review and resume");
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
    "Saved audio, including failed/old recordings, may be deleted immediately after resuming.",
  );
  expect(host.textContent).toContain("No transcription model assigned");
  expect(host.textContent).toContain("Voice models may download if missing");
  expect([...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain(
    "/portal/settings/models/transcriber",
  );
  expect(button("Resume restored work").disabled).toBe(true);
  await click("Cancel");
  expect(api.resumeRecordingRestoreReview).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test("pending audio with no transcriber stays blocked even after checkbox; assignment alone never resumes", async () => {
  api.getRecordingRestoreReview.mockResolvedValue({ ...choices, hasPendingChunks: true });
  await mount();
  await click("Review and resume");
  await confirm();
  expect(button("Resume restored work").disabled).toBe(true);
  expect(host.textContent).toContain("Choose transcription model");
  await click("Cancel");
  api.getRecordingRestoreReview.mockResolvedValue({
    ...choices,
    hasPendingChunks: true,
    transcriberAssignment: "local/fixture-transcriber",
    version: "b".repeat(64),
  });
  await click("Check again");
  await click("Review and resume");
  expect(api.resumeRecordingRestoreReview).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(Boolean(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked)).toBe(
    false,
  );
  expect(button("Resume restored work").disabled).toBe(true);
});

test("completed-only None can resume only after explicit review and authoritative pause removal", async () => {
  await mount();
  await click("Review and resume");
  await confirm();
  api.getRecordingRestoreReview.mockResolvedValue({
    ...choices,
    reviewRequired: false,
    version: "b".repeat(64),
  });
  await click("Resume restored work");
  expect(api.resumeRecordingRestoreReview).toHaveBeenCalledWith(
    choices.version,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(host.textContent).toContain("The restore pause is no longer active");
});

test("409 replaces choices and clears approval without retrying the POST", async () => {
  await mount();
  await click("Review and resume");
  await confirm();
  api.resumeRecordingRestoreReview.mockRejectedValue(
    Object.assign(new Error("changed"), { status: 409 }),
  );
  api.getRecordingRestoreReview.mockResolvedValue({
    ...choices,
    keepAudioDays: 7,
    version: "b".repeat(64),
  });
  await click("Resume restored work");
  expect(api.resumeRecordingRestoreReview).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("7 days");
  expect(host.textContent).toContain("confirm again");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
});

test("failed acknowledgement with unchanged policy never reports the pause removed", async () => {
  await mount();
  await click("Review and resume");
  await confirm();
  api.resumeRecordingRestoreReview.mockRejectedValue(new Error("offline"));
  await click("Resume restored work");
  expect(host.textContent).toContain("Resuming could not be confirmed");
  expect(host.textContent).not.toContain("The restore pause is no longer active");
  expect(button("Resume restored work").disabled).toBe(true);
});

test("stop waiting exits with unknown outcome until an explicit fresh observation", async () => {
  await mount();
  await click("Review and resume");
  await confirm();
  let signal: AbortSignal | undefined;
  api.resumeRecordingRestoreReview.mockImplementation(
    (_version: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        ),
      );
    },
  );
  await click("Resume restored work");
  api.getRecordingRestoreReview.mockResolvedValue({ ...choices, reviewRequired: false });
  await click("Stop waiting");
  expect(signal?.aborted).toBe(true);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).not.toContain("The restore pause is no longer active");
  expect(host.textContent).toContain("Waiting stopped");
  expect(api.resumeRecordingRestoreReview).toHaveBeenCalledOnce();
  await click("Check again");
  expect(host.textContent).not.toContain("Restored recordings are paused");
});

test("unmount aborts the outstanding read and late replies cannot mount controls", async () => {
  let signal: AbortSignal | undefined;
  let finish: (value: unknown) => void = () => {};
  api.getRecordingRestoreReview.mockImplementation((options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await mount();
  render(null, host);
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish(choices);
  });
  expect(host.textContent).toBe("");
});

test("untrusted model labels are escaped and never become navigation or markup", async () => {
  api.getRecordingRestoreReview.mockResolvedValue({
    ...choices,
    transcriberAssignment: "<img src=x onerror=alert(1)>",
  });
  await mount();
  expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(host.querySelector("img")).toBeNull();
});

test("Escape cancels review without changing the pause", async () => {
  await mount();
  await click("Review and resume");
  await act(async () => {
    const event = new window.Event("keydown");
    Object.defineProperty(event, "key", { value: "Escape" });
    window.dispatchEvent(event);
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(api.resumeRecordingRestoreReview).not.toHaveBeenCalled();
});

test("a failed fresh policy read disables mutation until choices can be verified again", async () => {
  await mount();
  await click("Review and resume");
  await confirm();
  api.getRecordingRestoreReview.mockRejectedValue(new Error("unknown policy"));
  await act(async () => {
    window.dispatchEvent(new window.Event("focus"));
  });
  await settle();
  expect(button("Resume restored work").disabled).toBe(true);
  expect(host.textContent).toContain("could not be checked");
  expect(api.resumeRecordingRestoreReview).not.toHaveBeenCalled();
});

test("an unknown or forbidden initial review never claims the pause removed or promotes capture", async () => {
  api.getRecordingRestoreReview.mockRejectedValue(
    Object.assign(new Error("forbidden"), { status: 403 }),
  );
  await mount("notice");
  expect(host.textContent).toBe("");
  expect(api.resumeRecordingRestoreReview).not.toHaveBeenCalled();
});

test("a replaced lifecycle aborts its request and ignores the older mutation acknowledgement", async () => {
  await mount();
  await click("Review and resume");
  await confirm();
  let finish: (value: unknown) => void = () => {};
  let signal: AbortSignal | undefined;
  api.resumeRecordingRestoreReview.mockImplementation(
    (_version: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  await click("Resume restored work");
  api.getRecordingRestoreReview.mockResolvedValue({
    ...choices,
    version: "b".repeat(64),
    hasPendingChunks: true,
  });
  await act(async () => {
    render(h(RecordingRestoreReview, { variant: "settings", refreshKey: "next" }), host);
  });
  await settle();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish({ ...choices, reviewRequired: false });
  });
  await settle();
  expect(host.textContent).toContain("Restored recordings are paused");
  expect(host.textContent).not.toContain("The restore pause is no longer active");
  expect(api.resumeRecordingRestoreReview).toHaveBeenCalledOnce();
});

for (const exit of ["Stop waiting", "Escape", "unmount"] as const) {
  test(`post-submit reconciliation can be exited by ${exit} and ignores late results`, async () => {
    await mount();
    await click("Review and resume");
    await confirm();
    let finish: (value: unknown) => void = () => {};
    let signal: AbortSignal | undefined;
    api.getRecordingRestoreReview.mockImplementation((options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await click("Resume restored work");
    expect(button("Stop waiting")).toBeDefined();
    if (exit === "unmount") {
      await act(async () => render(null, host));
    } else if (exit === "Escape") {
      await act(async () => {
        const event = new window.Event("keydown");
        Object.defineProperty(event, "key", { value: "Escape" });
        window.dispatchEvent(event);
      });
    } else await click(exit);
    expect(signal?.aborted).toBe(true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => finish({ ...choices, reviewRequired: false }));
    await settle();
    expect(host.textContent).not.toContain("The restore pause is no longer active");
    expect(api.resumeRecordingRestoreReview).toHaveBeenCalledOnce();
    if (exit !== "unmount") {
      expect(host.textContent).toContain("Waiting stopped");
      api.getRecordingRestoreReview.mockResolvedValue({ ...choices, version: "b".repeat(64) });
      await click("Review and resume");
      expect(button("Resume restored work").disabled).toBe(true);
    }
  });
}

test("a stalled reconciliation reaches its read deadline without confirming removal or retrying POST", async () => {
  await mount();
  await click("Review and resume");
  await confirm();
  let signal: AbortSignal | undefined;
  api.getRecordingRestoreReview.mockImplementation((options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  vi.useFakeTimers();
  await click("Resume restored work");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  await settle();
  expect(signal?.aborted).toBe(true);
  expect(button("Cancel")).toBeDefined();
  expect(button("Resume restored work").disabled).toBe(true);
  expect(host.textContent).toContain("Resuming could not be confirmed");
  expect(host.textContent).not.toContain("The restore pause is no longer active");
  expect(api.resumeRecordingRestoreReview).toHaveBeenCalledOnce();
  await click("Cancel");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
