// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_PERMISSION_STATE_KEY,
  PAIRING_KEY,
  PROFILE_LABEL_KEY,
  TOKEN_KEY,
} from "./storage.js";
import { initOptions } from "./options-page.js";
import {
  FakePageChrome,
  TEST_PAIRING,
  loadPage,
  pairedStorage,
  policyBody,
  type SentMessage,
} from "./page-test-fakes.js";

/**
 * The options / pairing page controller rendered into the shipped
 * `options.html` under linkedom. `chrome` is installed as the global (the
 * storage and permission helpers read it there) and handed to `initOptions`.
 * Every fixture is invented.
 */

interface Options {
  document: Document;
  window: { Event: typeof Event };
  chrome: FakePageChrome;
  $: (id: string) => HTMLElement;
  input: (id: string) => HTMLInputElement;
  status: () => { text: string; kind: string };
  exclusions: () => string[];
}

/** A worker that answers `read-policy` from a fixed exclusion list and acks everything else. */
function policyResponder(
  excludedDomains: string[] | null,
  onEdit: (message: SentMessage) => unknown = () => ({ ok: true, purged: 0 }),
): (message: SentMessage) => unknown {
  return (message) => {
    if (message.type === "read-policy") {
      return excludedDomains === null
        ? { policy: null, fetchedAt: null }
        : { policy: policyBody({ excludedDomains }), fetchedAt: 1 };
    }
    return onEdit(message);
  };
}

function openOptions(
  storage: Record<string, unknown>,
  configure: (chrome: FakePageChrome) => void = () => undefined,
): Options {
  const { document, window } = loadPage("options.html");
  const chrome = new FakePageChrome(storage);
  chrome.respond = policyResponder(null);
  configure(chrome);
  vi.stubGlobal("chrome", chrome.api);
  initOptions(document, chrome.api);
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  };
  return {
    document,
    window,
    chrome,
    $,
    input: (id) => $(id) as HTMLInputElement,
    status: () => ({
      text: $("status").textContent ?? "",
      kind: $("status").className.replace("status", "").trim(),
    }),
    exclusions: () =>
      [...$("exclusions").querySelectorAll("li span")].map((span) => span.textContent ?? ""),
  };
}

function click(options: Options, el: Element): void {
  el.dispatchEvent(new options.window.Event("click"));
}

function submit(options: Options, form: Element): void {
  form.dispatchEvent(new options.window.Event("submit", { cancelable: true }));
}

async function waitForStatus(options: Options, text: string): Promise<void> {
  await vi.waitFor(() => expect(options.status().text).toBe(text));
}

/** Storage as the worker leaves it once a pairing is committed. */
function commitPairing(chrome: FakePageChrome, gatewayUrl: string, profileLabel?: string): void {
  chrome.storage[PAIRING_KEY] = JSON.stringify({ ...TEST_PAIRING, gatewayUrl });
  chrome.storage[TOKEN_KEY] = "invented-token";
  if (profileLabel) chrome.storage[PROFILE_LABEL_KEY] = profileLabel;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("options — paired state", () => {
  it("shows the pairing form to an unpaired browser and hides the shared exclusions", async () => {
    const options = openOptions({}, (chrome) => {
      chrome.hostPermission = false;
    });
    await vi.waitFor(() => expect(options.$("pair-form").style.display).toBe("block"));
    expect(options.$("paired").style.display).toBe("none");
    expect(options.$("save-profile-label").hidden).toBe(true);
    expect(options.$("profile-label-missing").hidden).toBe(true);
    expect(options.$("capture-permission-missing").hidden).toBe(true);
    expect(options.$("unpaired-capture-access").hidden).toBe(true);
    await vi.waitFor(() => expect(options.$("exclusion-form").hidden).toBe(true));
    expect(options.$("exclusions-empty").textContent).toBe(
      "Pair this browser to manage the exclusions shared by your paired browsers.",
    );
    expect(options.$("exclusions-empty").style.display).toBe("block");
    expect(options.status().text).toBe("");
  });

  it("offers to remove page access an unpaired browser still holds", async () => {
    const options = openOptions({});
    await vi.waitFor(() => expect(options.$("unpaired-capture-access").hidden).toBe(false));
    click(options, options.$("revoke-capture-access"));
    await vi.waitFor(() =>
      expect(options.chrome.sent("revoke-capture-access")).toEqual([
        { type: "revoke-capture-access" },
      ]),
    );
    await waitForStatus(options, "HTTPS page access removed.");
    expect(options.status().kind).toBe("status-info");
  });

  it("shows the pairing with its gateway, scopes and profile name", async () => {
    const options = openOptions(pairedStorage());
    await vi.waitFor(() => expect(options.$("paired").style.display).toBe("block"));
    expect(options.$("pair-form").style.display).toBe("none");
    expect(options.$("paired-gateway").textContent).toBe("https://gateway.example.com");
    expect(options.$("paired-scopes").textContent).toBe("write:web");
    expect(options.input("profile-label").value).toBe("Personal");
    expect(options.$("save-profile-label").hidden).toBe(false);
    expect(options.$("profile-label-missing").hidden).toBe(true);
    expect(options.$("capture-permission-missing").hidden).toBe(true);
    expect(options.$("unpaired-capture-access").hidden).toBe(true);
  });

  it("asks a paired browser without a profile name to add one", async () => {
    const options = openOptions(pairedStorage({ [PROFILE_LABEL_KEY]: undefined }));
    delete options.chrome.storage[PROFILE_LABEL_KEY];
    await vi.waitFor(() => expect(options.$("paired").style.display).toBe("block"));
    await vi.waitFor(() => expect(options.$("profile-label-missing").hidden).toBe(false));
  });

  it("saves the profile name through the worker", async () => {
    const options = openOptions(pairedStorage());
    await vi.waitFor(() => expect(options.$("paired").style.display).toBe("block"));
    options.input("profile-label").value = "  Work  ";
    click(options, options.$("save-profile-label"));
    await vi.waitFor(() =>
      expect(options.chrome.sent("set-profile-label")).toEqual([
        { type: "set-profile-label", profileLabel: "Work" },
      ]),
    );
    await waitForStatus(options, "Chrome profile name saved.");
    expect(options.status().kind).toBe("status-ok");
  });

  it("refuses an empty profile name before asking the worker", async () => {
    const options = openOptions(pairedStorage());
    await vi.waitFor(() => expect(options.$("paired").style.display).toBe("block"));
    options.input("profile-label").value = "   ";
    click(options, options.$("save-profile-label"));
    await waitForStatus(options, "Could not save profile name: Enter this Chrome profile's name.");
    expect(options.chrome.sent("set-profile-label")).toEqual([]);
  });

  it("offers to repair missing HTTPS access and asks the worker to re-check after the grant", async () => {
    const options = openOptions(pairedStorage(), (chrome) => {
      chrome.contentScriptRegistered = false;
    });
    await vi.waitFor(() => expect(options.$("capture-permission-missing").hidden).toBe(false));
    click(options, options.$("grant-capture-permission"));
    await vi.waitFor(() => expect(options.chrome.sent("check-now")).toHaveLength(1));
    expect(options.chrome.permissionRequests).toEqual([{ origins: ["https://*/*"] }]);
    await waitForStatus(
      options,
      "HTTPS page access granted. Reload any already-open page to start watching it.",
    );
  });

  it("reports a startup failure instead of a silently blank page", async () => {
    const options = openOptions(pairedStorage(), (chrome) => {
      chrome.respond = () => {
        throw new Error("worker unavailable");
      };
    });
    await waitForStatus(
      options,
      "Could not load extension settings: worker unavailable. Reload the extension and this page, then try again.",
    );
    expect(options.status().kind).toBe("status-error");
  });
});

describe("options — pairing form", () => {
  it("requests HTTPS access, hands the pairing to the worker, then asks it to re-check", async () => {
    const options = openOptions({}, (chrome) => {
      chrome.hostPermission = false;
      chrome.respond = (message) => {
        if (message.type === "pair-browser") {
          commitPairing(chrome, message.gatewayUrl as string, message.profileLabel as string);
        }
        return policyResponder([])(message);
      };
    });
    await vi.waitFor(() => expect(options.$("pair-form").style.display).toBe("block"));
    options.input("gateway-url").value = "  https://Gateway.Example.com:7600/  ";
    options.input("pairing-code").value = "ABCDE12345";
    options.input("profile-label").value = "Personal";
    submit(options, options.$("pair-form"));
    await waitForStatus(options, "Paired. You can close this page.");
    expect(options.status().kind).toBe("status-ok");
    expect(options.chrome.permissionRequests).toEqual([{ origins: ["https://*/*"] }]);
    expect(options.chrome.messages.map((message) => message.type)).toEqual([
      "read-policy",
      "pair-browser",
      "check-now",
    ]);
    expect(options.chrome.sent("pair-browser")[0]).toEqual({
      type: "pair-browser",
      gatewayUrl: "https://gateway.example.com:7600",
      pairingCode: "ABCDE12345",
      profileLabel: "Personal",
    });
    expect(options.$("paired").style.display).toBe("block");
    expect(options.$("paired-gateway").textContent).toBe("https://gateway.example.com:7600");
    expect((options.$("pair-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("surfaces the worker's permission warning after a committed pairing", async () => {
    const options = openOptions({}, (chrome) => {
      chrome.respond = (message) => {
        if (message.type === "pair-browser") {
          commitPairing(chrome, message.gatewayUrl as string);
          return { ok: true, warning: "Paired, but Chrome HTTPS page access needs repair" };
        }
        return policyResponder([])(message);
      };
    });
    await vi.waitFor(() => expect(options.$("pair-form").style.display).toBe("block"));
    options.input("gateway-url").value = "https://gateway.example.com";
    options.input("pairing-code").value = "ABCDE12345";
    options.input("profile-label").value = "Personal";
    submit(options, options.$("pair-form"));
    await waitForStatus(
      options,
      "Paired, but Chrome HTTPS page access needs repair. Grant HTTPS page access below.",
    );
    expect(options.status().kind).toBe("status-error");
  });

  it("rejects an IP-literal gateway before requesting access or messaging the worker", async () => {
    const options = openOptions({});
    await vi.waitFor(() => expect(options.$("pair-form").style.display).toBe("block"));
    options.input("gateway-url").value = "https://203.0.113.10:7600";
    options.input("pairing-code").value = "ABCDE12345";
    options.input("profile-label").value = "Personal";
    submit(options, options.$("pair-form"));
    await vi.waitFor(() => expect(options.status().text).toContain("trusted hostname"));
    expect(options.status().kind).toBe("status-error");
    expect(options.chrome.permissionRequests).toEqual([]);
    expect(options.chrome.sent("pair-browser")).toEqual([]);
  });

  it("requires a profile name before pairing", async () => {
    const options = openOptions({});
    await vi.waitFor(() => expect(options.$("pair-form").style.display).toBe("block"));
    options.input("gateway-url").value = "https://gateway.example.com";
    options.input("pairing-code").value = "ABCDE12345";
    options.input("profile-label").value = "";
    submit(options, options.$("pair-form"));
    await waitForStatus(options, "Pairing failed: Enter this Chrome profile's name.");
    expect(options.chrome.sent("pair-browser")).toEqual([]);
  });

  it("shows the worker's refusal verbatim and sends one pairing per submit", async () => {
    let release: ((ack: unknown) => void) | undefined;
    const options = openOptions({}, (chrome) => {
      chrome.respond = (message) =>
        message.type === "pair-browser"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : policyResponder(null)(message);
    });
    await vi.waitFor(() => expect(options.$("pair-form").style.display).toBe("block"));
    options.input("gateway-url").value = "https://gateway.example.com";
    options.input("pairing-code").value = "ABCDE12345";
    options.input("profile-label").value = "Personal";
    submit(options, options.$("pair-form"));
    submit(options, options.$("pair-form"));
    await vi.waitFor(() => expect(options.chrome.sent("pair-browser")).toHaveLength(1));
    expect(options.status().text).toBe("Pairing…");
    expect((options.$("pair-submit") as HTMLButtonElement).disabled).toBe(true);

    release?.({ ok: false, reason: "Pairing failed: invalid or expired code" });
    await waitForStatus(options, "Pairing failed: invalid or expired code");
    expect((options.$("pair-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(options.$("pair-form").style.display).toBe("block");
  });

  it("unpairs through the worker and returns to the form", async () => {
    const options = openOptions(pairedStorage(), (chrome) => {
      chrome.respond = (message) => {
        if (message.type === "unpair") {
          delete chrome.storage[PAIRING_KEY];
          delete chrome.storage[TOKEN_KEY];
          delete chrome.storage[CAPTURE_PERMISSION_STATE_KEY];
          chrome.hostPermission = false;
          return { ok: true };
        }
        return policyResponder(chrome.storage[PAIRING_KEY] ? ["bank.example"] : null)(message);
      };
    });
    await vi.waitFor(() => expect(options.exclusions()).toEqual(["bank.example"]));
    click(options, options.$("unpair"));
    await waitForStatus(options, "Unpaired. The extension will stop pushing until you pair again.");
    expect(options.chrome.sent("unpair")).toEqual([{ type: "unpair" }]);
    expect(options.$("pair-form").style.display).toBe("block");
    expect(options.$("paired").style.display).toBe("none");
    expect(options.exclusions()).toEqual([]);
    expect(options.$("exclusion-form").hidden).toBe(true);
  });

  it("names the page access Chrome kept after an unpair", async () => {
    const options = openOptions(pairedStorage(), (chrome) => {
      chrome.respond = (message) =>
        message.type === "unpair"
          ? { ok: true, warning: "Chrome kept HTTPS page access after the extension was unpaired" }
          : policyResponder(null)(message);
    });
    await vi.waitFor(() => expect(options.$("paired").style.display).toBe("block"));
    click(options, options.$("unpair"));
    await waitForStatus(
      options,
      "Unpaired, but Chrome could not remove page access: Chrome kept HTTPS page access after the extension was unpaired. Remove it in the extension's site-access settings.",
    );
    expect(options.status().kind).toBe("status-error");
  });
});

describe("options — shared exclusions", () => {
  it("says when the capture settings have not been loaded yet", async () => {
    const options = openOptions(pairedStorage());
    await vi.waitFor(() => expect(options.$("exclusion-form").hidden).toBe(false));
    expect(options.$("exclusions-empty").textContent).toBe(
      "Capture settings have not been loaded from the gateway yet.",
    );
    expect(options.$("exclusions-empty").style.display).toBe("block");
  });

  it("renders the gateway's list as plain text with a remove control per entry", async () => {
    const options = openOptions(pairedStorage(), (chrome) => {
      chrome.respond = policyResponder([]);
    });
    await vi.waitFor(() => expect(options.$("exclusion-form").hidden).toBe(false));
    expect(options.$("exclusions-empty").textContent).toBe("No domains excluded yet.");

    let excluded = ["bank.example", "<img src=x>.example.com"];
    const withList = openOptions(pairedStorage(), (chrome) => {
      chrome.respond = policyResponder(excluded, (message) => {
        if (message.type === "remove-excluded-domain") {
          excluded = excluded.filter((domain) => domain !== message.domain);
          chrome.respond = policyResponder(excluded);
        }
        return { ok: true, purged: 0 };
      });
    });
    await vi.waitFor(() =>
      expect(withList.exclusions()).toEqual(["bank.example", "<img src=x>.example.com"]),
    );
    expect(withList.$("exclusions-empty").style.display).toBe("none");
    const items = [...withList.$("exclusions").querySelectorAll("li")];
    expect(items[1].querySelector("span")?.childElementCount).toBe(0);
    const remove = items[0].querySelector("button") as HTMLButtonElement;
    expect(remove.textContent).toBe("Remove");
    expect(remove.getAttribute("type")).toBe("button");

    click(withList, remove);
    await vi.waitFor(() =>
      expect(withList.chrome.sent("remove-excluded-domain")).toEqual([
        { type: "remove-excluded-domain", domain: "bank.example" },
      ]),
    );
    await waitForStatus(withList, "bank.example is no longer excluded in any paired browser.");
    await vi.waitFor(() => expect(withList.exclusions()).toEqual(["<img src=x>.example.com"]));
  });

  it("adds a domain with the purge choice and reports the deleted pages", async () => {
    let excluded: string[] = [];
    const options = openOptions(pairedStorage(), (chrome) => {
      chrome.respond = policyResponder(excluded, (message) => {
        if (message.type === "add-excluded-domain") {
          excluded = [...excluded, "news.example.com"];
          chrome.respond = policyResponder(excluded);
          return { ok: true, purged: message.purge ? 3 : 0 };
        }
        return { ok: true, purged: 0 };
      });
    });
    await vi.waitFor(() => expect(options.$("exclusion-form").hidden).toBe(false));
    options.input("exclusion-input").value = "  News.Example.com  ";
    options.input("exclusion-purge").checked = true;
    submit(options, options.$("exclusion-form"));
    await vi.waitFor(() =>
      expect(options.chrome.sent("add-excluded-domain")).toEqual([
        { type: "add-excluded-domain", input: "  News.Example.com  ", purge: true },
      ]),
    );
    await waitForStatus(
      options,
      "news.example.com is excluded in every paired browser; 3 captured pages deleted.",
    );
    expect(options.status().kind).toBe("status-ok");
    expect(options.input("exclusion-input").value).toBe("");
    await vi.waitFor(() => expect(options.exclusions()).toEqual(["news.example.com"]));
  });

  it("adds a domain without purging and says so", async () => {
    const options = openOptions(pairedStorage(), (chrome) => {
      chrome.respond = policyResponder([]);
    });
    await vi.waitFor(() => expect(options.$("exclusion-form").hidden).toBe(false));
    options.input("exclusion-input").value = "docs.example.org";
    // linkedom reports an untouched checkbox as `undefined`; a browser says false.
    options.input("exclusion-purge").checked = false;
    submit(options, options.$("exclusion-form"));
    await waitForStatus(options, "docs.example.org is excluded in every paired browser.");
    expect(options.chrome.sent("add-excluded-domain")).toEqual([
      { type: "add-excluded-domain", input: "docs.example.org", purge: false },
    ]);
  });

  it("refuses an invalid domain locally and reports a worker refusal", async () => {
    const options = openOptions(pairedStorage(), (chrome) => {
      chrome.respond = policyResponder([], () => ({ ok: false, reason: "Not a valid domain" }));
    });
    await vi.waitFor(() => expect(options.$("exclusion-form").hidden).toBe(false));
    options.input("exclusion-input").value = "not a domain!!";
    submit(options, options.$("exclusion-form"));
    await waitForStatus(options, '"not a domain!!" isn\'t a valid domain.');
    expect(options.chrome.sent("add-excluded-domain")).toEqual([]);

    options.input("exclusion-input").value = "shop.example.net";
    submit(options, options.$("exclusion-form"));
    await waitForStatus(options, "Could not update exclusions: Not a valid domain");
    expect(options.status().kind).toBe("status-error");
    expect(options.input("exclusion-input").value).toBe("shop.example.net");
  });
});
