// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A typed challenge, rendered.
 *
 * The claim under test is a structural one: this component renders a *kind*,
 * and every word an operator reads comes from the provider that asked. Before
 * this existed, the instruction telling someone what to do with a pairing code
 * was written into this file, naming one particular app — which meant the
 * second source to need a pairing code would have found the wrong sentence
 * already on screen.
 *
 * Not reachable by the screenshot loop: the flow it belongs to starts only
 * after a paired collector advertises its descriptors, and the isolated
 * gateway that loop boots has no collector.
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import {
  ChallengeStep,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "./auth-flow.js";

async function renderChallenge(
  challenge: Record<string, unknown>,
  status?: string,
  opts?: { collectorName?: string; hostname?: string },
) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const parsed = parseHTML("<html><body><div id='host'></div></body></html>");
  // Whether this browser is on the machine the redirect lands on is read from
  // the address bar, so a test that cares has to say where it is standing.
  Object.defineProperty(parsed.window, "location", {
    value: { hostname: opts?.hostname ?? "gateway.example.org" },
    configurable: true,
  });
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  const host = parsed.document.querySelector("#host") as unknown as HTMLElement;
  await act(async () => {
    render(
      h(ChallengeStep, {
        flowId: "F",
        challenge,
        status,
        collectorName: opts?.collectorName,
        onCancel: () => {},
      }),
      host,
    );
  });
  const text = host.textContent ?? "";
  const inputs = [...host.querySelectorAll("input")].map((i) => i.getAttribute("type"));
  const labels = [...host.querySelectorAll("label")].map((l) => l.textContent);
  const links = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  const selects = [...host.querySelectorAll("select")].map((sel) =>
    [...sel.querySelectorAll("option")].map((o) => o.getAttribute("value")),
  );
  render(null, host);
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  return { text, inputs, labels, links, selects };
}

describe("a rendered challenge", () => {
  it("shows the provider's own title and instructions, whatever the kind", async () => {
    const { text } = await renderChallenge({
      id: "c1",
      kind: "qr",
      title: "Scan this from your phone",
      instructions: "Open the app, then Settings, then Linked devices.",
      data: "pairing-payload",
    });

    expect(text).toContain("Scan this from your phone");
    expect(text).toContain("Linked devices");
  });

  it("offers a link for a redirect", async () => {
    const { links, text } = await renderChallenge({
      id: "c1",
      kind: "redirect",
      title: "Approve access",
      url: "https://example.com/consent?state=F",
      via: "gateway",
    });

    expect(links).toContain("https://example.com/consent?state=F");
    expect(text).toContain("Approve access");
  });

  it("offers one box for a code", async () => {
    const { inputs, text } = await renderChallenge({
      id: "c1",
      kind: "code",
      title: "Paste the code from your browser",
    });

    expect(inputs).toEqual(["text"]);
    expect(text).toContain("Paste the code");
  });

  it("masks a secret field and leaves an ordinary one visible", async () => {
    const { inputs, labels } = await renderChallenge({
      id: "c1",
      kind: "fields",
      title: "Connect an account",
      fields: [
        { name: "token", label: "Access token", type: "secret", required: true },
        { name: "label", label: "Connection name", type: "string" },
      ],
    });

    expect(inputs).toEqual(["password", "text"]);
    expect(labels[0]).toContain("Access token");
    expect(labels[0]).toContain("*");
    expect(labels[1]).not.toContain("*");
  });

  it("shows a field's own help line", async () => {
    const { text } = await renderChallenge({
      id: "c1",
      kind: "fields",
      title: "Connect an account",
      fields: [
        { name: "t", label: "Token", type: "secret", help: "A token with read access." },
      ],
    });

    expect(text).toContain("A token with read access.");
  });

  it("shows a status line beside whatever is being asked", async () => {
    const { text } = await renderChallenge(
      { id: "c1", kind: "code", title: "Paste the code" },
      "Still waiting for your bank",
    );

    expect(text).toContain("Still waiting for your bank");
  });

  it("names no platform of its own", async () => {
    // The regression this file exists for. A challenge that mentions nothing
    // should render nothing that does.
    const { text } = await renderChallenge({
      id: "c1",
      kind: "qr",
      title: "Scan the code",
      data: "payload",
    });

    expect(text.toLowerCase()).not.toMatch(/whatsapp|google|github|plaid/);
  });
});

describe("a redirect challenge", () => {
  const loopback = {
    id: "c9",
    kind: "redirect",
    via: "loopback",
    title: "Sign in",
    url: "https://example.org/authorize?client_id=x",
  };

  it("warns that the redirect lands somewhere this browser is not, and names the machine", async () => {
    const { text } = await renderChallenge(loopback, undefined, {
      collectorName: "workshop-mini",
      hostname: "gateway.example.org",
    });
    expect(text).toContain("Complete sign-in on the collector's machine");
    expect(text).toContain("workshop-mini");
  });

  it("keeps quiet when this browser is on that machine", async () => {
    const { text } = await renderChallenge(loopback, undefined, { hostname: "localhost" });
    expect(text).not.toContain("Complete sign-in on the collector's machine");
  });

  it("does not warn when the host itself catches the redirect", async () => {
    const { text } = await renderChallenge(
      { ...loopback, via: "gateway" },
      undefined,
      { hostname: "gateway.example.org" },
    );
    expect(text).not.toContain("Complete sign-in on the collector's machine");
  });

  it("offers a way to answer only when an answer is wanted", async () => {
    // A provider reading its own loopback callback wants nothing back. An
    // input here would be worse than none: the operator types into a flow
    // that is not listening, and it hangs until it expires.
    const shown = await renderChallenge({ ...loopback, expectsAnswer: false });
    expect(shown.text).not.toContain("paste the redirect URL");
    expect(shown.inputs).toEqual([]);

    const asked = await renderChallenge({ ...loopback, expectsAnswer: true });
    expect(asked.text.toLowerCase()).toContain("paste the redirect url");
    expect(asked.inputs).toEqual(["text"]);
  });

  it("shows the URL either way", async () => {
    const shown = await renderChallenge({ ...loopback, expectsAnswer: false });
    expect(shown.links).toContain("https://example.org/authorize?client_id=x");
  });
});

describe("a fields challenge", () => {
  it("renders a choice as a choice, not as a box to retype it into", async () => {
    // The provider that needs this asks for a country and then builds its
    // second question from that country's live bank list. A text box makes the
    // second question unanswerable without knowing the exact spelling the API
    // returns, which is the failure the two-step flow exists to remove.
    const { selects, inputs } = await renderChallenge({
      id: "c1",
      kind: "fields",
      title: "Where is your account held?",
      fields: [
        {
          name: "country",
          label: "Country",
          type: "select",
          required: true,
          options: [
            { value: "IE", label: "Ireland" },
            { value: "PT", label: "Portugal" },
          ],
        },
      ],
    });
    expect(selects).toEqual([["", "IE", "PT"]]);
    expect(inputs).toEqual([]);
  });

  it("still renders a plain field as a box, and a secret as a masked one", async () => {
    const { inputs, selects } = await renderChallenge({
      id: "c2",
      kind: "fields",
      title: "Sign in",
      fields: [
        { name: "username", label: "Username", type: "string", required: true },
        { name: "password", label: "Password", type: "secret", required: true },
      ],
    });
    expect(inputs).toEqual(["text", "password"]);
    expect(selects).toEqual([]);
  });
});
