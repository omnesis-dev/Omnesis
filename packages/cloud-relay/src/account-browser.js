// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/* global document, window */

/** Self-contained so the relay can serve the bundled function under a self-only script CSP. */
export function installAccountUI() {
  const root = document.getElementById("account-root");
  const alert = document.getElementById("account-error");
  const query = new URLSearchParams(window.location.search);
  const operationKey = ["desktop", "signup", "operation"].find((key) => query.has(key));
  const operation = operationKey && query.get(operationKey);
  // A front door may ask for the gateway itself; an operation always keeps its own page.
  const opens = query.getAll("open");
  const openPortal = !operationKey && opens.length === 1 && opens[0] === "portal";
  const pendingCopy = {
    "desktop-discovery": {
      title: "Connect this device",
      signIn: "Sign in to your Omnesis account to connect this device to your gateway.",
      ready:
        "Your gateway's setting decides whether this device joins right away or waits for your approval.",
      action: "Continue on this device",
      approval:
        "You're signing in on a different device from the one you're connecting, so it will wait until you approve it on your phone or another device that's already paired.",
    },
    "gateway-signup": {
      title: "Sign in to your Omnesis account",
      signIn: "Sign in to connect this gateway to your Omnesis account.",
      // Once signed in, the page is the one step left.
      readyTitle: "Connect this gateway to your Omnesis account",
      ready: "This adds the gateway to your Omnesis account so your devices can find it.",
      action: "Connect this gateway",
    },
    "owner-link": {
      title: "Sign in to your Omnesis account",
      signIn: "Sign in with the Omnesis account you want to connect this gateway to.",
      readyTitle: "Connect this gateway to your Omnesis account",
      ready: "This adds the gateway to your Omnesis account so your devices can find it.",
      action: "Connect this gateway",
    },
    "device-enrollment": {
      title: "Pair this browser",
      signIn: "Sign in to your Omnesis account to pair this browser with your gateway.",
      ready:
        "Your gateway's setting decides whether this browser joins right away or waits for your approval.",
      action: "Continue pairing",
      automatic: true,
    },
  };
  // The one sign-in a gateway's page already chose, such as its "Continue with Google" button.
  const methodCopy = {
    google: {
      title: "Continue with Google",
      signIn: "Sign in to this gateway with the Google account you use for Omnesis.",
      action: "Continue with Google",
    },
    passkey: {
      title: "Continue with your passkey",
      signIn: "Sign in to this gateway with the passkey you use for Omnesis.",
      action: "Continue with passkey",
    },
  };
  // Shown instead of the sign-in copy when the person chose to create an account.
  const createCopy = {
    title: "Create your Omnesis account",
    lines: [
      "An Omnesis account helps your devices find this gateway from anywhere. Only your gateway decides who gets in.",
      "Your data stays on your gateway. The account only knows which gateways are yours and how you sign in.",
      "Creating the account also connects this gateway to it.",
    ],
  };
  const noAccount = "There's no Omnesis account for this sign-in.";
  // Omnesis accounts are invite-only: these say what to do when an invite is missing or spent.
  const inviteNeeded = [
    "Omnesis accounts are invite-only for now. Creating one needs an invite link.",
    "If you have one, start again from your gateway and paste it there. Otherwise, sign in to an account you already have.",
  ];
  const inviteUnusable =
    "This invite can't create an account any more: it has expired or was already used. Ask for a new invite, then start again from your gateway.";
  const signInFailed = "Sign-in did not complete. Please try again.";
  const signInRefused = "That didn't sign you in. Try again, or use another sign-in method.";
  // No account has this passkey any more, such as after the account was deleted.
  const unknownPasskey = "That passkey is for an Omnesis account that no longer exists.";
  // Back from a Google start the browser didn't vouch for, so nothing happened yet.
  const googleAgain = "To continue with Google, press the Google button again.";
  // Everything deleting the account does, said before the person confirms it.
  const deletionLines = [
    "All your gateways are disconnected from this account and can no longer be reached from outside your home network.",
    "New devices can no longer join by signing in.",
    "Devices you already paired keep working on your home network.",
    "Your sign-in methods and everything this service stores about your account are deleted.",
    "This can't be undone. You can create a new account later from a gateway.",
  ];
  // What unlinking one gateway does, said before the person confirms it.
  const unlinkLines = [
    "Nothing on the gateway is deleted. Its data stays where it is.",
    "It can no longer be reached from outside your home network, and new devices can no longer join it by signing in. Devices you already paired keep working on your home network.",
    "To use it from outside your home network again, connect it again from its settings.",
  ];
  const handoffKey = "omnesis.portal-handoff";
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  // One persistent element, so a result is announced where the person is looking.
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  const fresh = new Set();
  let busy = false,
    current,
    confirming,
    endorsing,
    continued = false,
    // The "more options" menu of the account view on screen, if that is the view.
    more,
    // Every menu on screen: the account's and each gateway's. At most one is open.
    menus = [],
    notice = "",
    // The section the message belongs to: the gateways, or the sign-in methods.
    noticeAt = "methods",
    // The gateways section on screen, where a message about a gateway is shown.
    gatewaysSection,
    // Counts actions, so a background refresh can tell one started while it was reading.
    generation = 0,
    failure = signInFailed,
    // What this page's own sign-in hands to a gateway's portal, so the portal asks for no second one.
    handoff;
  const ui = {
    async api(path, value, endorse) {
      const target = new URL(`/_relay/account/api/${path}`, window.location.origin);
      if (operation) target.searchParams.set(operationKey, operation);
      // Names the new passkey that this sign-in vouches for.
      else if (endorse) target.searchParams.set("endorse", endorse);
      // Only the sign-in itself is bound to the handoff, never a change to the sign-in methods.
      else if (
        handoff &&
        (path === "session" ||
          path === "portal/handoff" ||
          (path.startsWith("passkeys/authenticate/") && !current.authenticated))
      )
        target.searchParams.set("portal", handoff.operationId);
      const response = await fetch(target.pathname + target.search, {
        method: value === undefined ? "GET" : "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: value === undefined ? {} : { "content-type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
      if (response.status === 401 && path !== "session") {
        // Signed out, a refusal is about the sign-in itself, not about a lapsed confirmation.
        const signedIn = current.authenticated,
          reason =
            response.headers.get("content-type") === "application/json"
              ? (await response.json()).error
              : undefined;
        await ui.refresh();
        const error = new Error("Sign in again to manage sign-in methods");
        error.name =
          reason === "unknown-passkey" || reason === "deleted-passkey"
            ? "UnknownPasskey"
            : signedIn
              ? "AccountSignInRequired"
              : "SignInRefused";
        // Only a passkey whose account the service deleted is gone for good; any other may still
        // belong to a live account, so the password manager keeps it.
        error.forget = reason === "deleted-passkey";
        throw error;
      }
      if (!response.ok) {
        const reason =
          response.headers.get("content-type") === "application/json"
            ? (await response.json()).error
            : undefined;
        const error = new Error(
          "This request could not be completed. Sign in again or try another sign-in method.",
        );
        error.status = response.status;
        // The relay names a refused invite, which the page says in place of the generic failure.
        if (typeof reason === "string" && reason.startsWith("invite-"))
          error.name = "InviteUnusable";
        throw error;
      }
      return response.json();
    },
    decode(value) {
      return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
        character.charCodeAt(0),
      );
    },
    encode(value) {
      return btoa(String.fromCharCode(...new Uint8Array(value)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    },
    node(tag, text) {
      const element = document.createElement(tag);
      element.textContent = text;
      return element;
    },
    button(text, action, secondary = false, parent = root) {
      const element = ui.node("button", text);
      element.type = "button";
      // Drawn during an action, it waits for the action like the rest of the page.
      element.disabled = busy;
      if (secondary) element.className = "secondary";
      element.addEventListener("click", () => ui.run(action));
      parent.append(element);
      return element;
    },
    googleButton(text, action, secondary = false, parent = root) {
      const button = ui.button(text, action, secondary, parent);
      const mark = document.createElement("img");
      mark.src = "/_relay/account/google-mark";
      mark.alt = "";
      mark.width = 20;
      mark.height = 20;
      button.prepend(mark);
      return button;
    },
    async run(action) {
      if (busy) return;
      busy = true;
      // A refresh started before this action must not draw over what the action shows.
      generation++;
      alert.textContent = "";
      ui.say("");
      failure = signInFailed;
      for (const element of root.querySelectorAll("button")) element.disabled = true;
      try {
        await action();
      } catch (error) {
        alert.textContent =
          error?.name === "AccountSignInRequired"
            ? "Sign in again to manage sign-in methods. Use the same Omnesis account, then retry your change."
            : error?.name === "SignInRefused"
              ? signInRefused
              : error?.name === "UnknownPasskey"
                ? `${unknownPasskey} ${current.googleAvailable ? "Choose another passkey, or continue with Google." : "Choose another passkey."}`
                : error?.name === "InviteUnusable"
                  ? inviteUnusable
                  : error?.name === "NotAllowedError" || error?.name === "AbortError"
                    ? "No passkey was used. The request may have been cancelled, timed out, or no matching passkey was available. Try again, or sign in with Google to add a passkey."
                    : failure;
      } finally {
        busy = false;
        for (const element of root.querySelectorAll("button"))
          element.disabled = element.dataset.unavailable === "1";
      }
    },
    date(value) {
      return day.format(new Date(value));
    },
    say(text, at = "methods") {
      notice = text;
      noticeAt = at;
      status.textContent = text;
      if (at === "gateways" && gatewaysSection?.isConnected) gatewaysSection.append(status);
    },
    /** Names the platform family only, so several passkeys can be told apart. */
    label() {
      const platform = String(navigator.userAgentData?.platform || navigator.platform || "");
      // An iPad reports itself as a Mac with a touch screen.
      const family =
        /^mac/i.test(platform) && navigator.maxTouchPoints > 1
          ? "iPad"
          : [
              ["iPhone", /^iphone/i],
              ["iPad", /^ipad/i],
              ["Android", /android/i],
              ["Mac", /^mac/i],
              ["Windows", /^win/i],
            ].find(([, pattern]) => pattern.test(platform))?.[0];
      return family ? `Passkey on ${family}` : "Passkey";
    },
    /** `countersign` signs with the passkey being added, which `endorse` names. */
    async passkey(register, createAccount = false, endorse, countersign = false) {
      if (!window.PublicKeyCredential || !navigator.credentials)
        throw new Error("Passkeys unavailable");
      const step = countersign ? "countersign" : register ? "register" : "authenticate";
      const ceremony = await ui.api(
        `passkeys/${step}/options`,
        register ? { createAccount, label: ui.label() } : {},
        endorse,
      );
      const options = ceremony.options;
      options.challenge = ui.decode(options.challenge);
      let result;
      if (register) {
        options.user.id = ui.decode(options.user.id);
        options.excludeCredentials = (options.excludeCredentials ?? []).map((credential) => ({
          ...credential,
          id: ui.decode(credential.id),
        }));
        result = await navigator.credentials.create({ publicKey: options });
      } else {
        options.allowCredentials = (options.allowCredentials ?? []).map((credential) => ({
          ...credential,
          id: ui.decode(credential.id),
        }));
        result = await navigator.credentials.get({ publicKey: options });
      }
      if (!result || result.type !== "public-key") throw new Error("Passkey unavailable");
      const credential = {
        id: result.id,
        rawId: ui.encode(result.rawId),
        type: "public-key",
        clientExtensionResults: result.getClientExtensionResults(),
        response: { clientDataJSON: ui.encode(result.response.clientDataJSON) },
      };
      if (register) {
        credential.response.attestationObject = ui.encode(result.response.attestationObject);
        credential.response.transports = result.response.getTransports?.() ?? [];
      } else {
        credential.response.authenticatorData = ui.encode(result.response.authenticatorData);
        credential.response.signature = ui.encode(result.response.signature);
        if (!result.response.userHandle) throw new Error("Discoverable passkey required");
        credential.response.userHandle = ui.encode(result.response.userHandle);
      }
      let done;
      try {
        done = await ui.api(
          `passkeys/${step}/complete`,
          { ceremonyId: ceremony.ceremonyId, credential },
          endorse,
        );
      } catch (error) {
        // The browser offered a passkey nothing will accept again, so it may stop offering it.
        if (error.forget) await ui.forgetPasskey(result.id);
        throw error;
      }
      return { id: result.id, endorse: done.endorse };
    },
    /** Best effort: lets the browser's password manager drop a passkey nothing accepts now. */
    async forgetPasskey(credentialId) {
      try {
        await window.PublicKeyCredential.signalUnknownCredential?.({
          rpId: window.location.hostname,
          credentialId,
        });
      } catch {
        // The passkey stays in the password manager, where it can be deleted by hand.
      }
    },
    async signIn(createAccount = false) {
      await ui.passkey(createAccount, createAccount);
      await ui.refresh();
    },
    forget() {
      handoff = undefined;
      try {
        window.sessionStorage.removeItem(handoffKey);
      } catch {
        // Nothing was stored where storage is blocked.
      }
    },
    /** The handoff an earlier load of this page prepared, such as before the Google round trip. */
    restore() {
      try {
        const value = JSON.parse(window.sessionStorage.getItem(handoffKey)),
          named = query.getAll("portal");
        if (
          /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId) &&
          (named.length === 0 || (named.length === 1 && named[0] === value.operationId))
        )
          handoff = value;
      } catch {
        // Unreadable storage holds no handoff.
      }
      if (!handoff) ui.forget();
    },
    /**
     * Makes the device key and request a gateway's portal will use, and starts the operation that
     * binds this page's sign-in to them. The nonce is `enrollmentNonce` from device-enrollment.ts.
     */
    async prepare() {
      handoff = undefined;
      try {
        const { subtle } = window.crypto,
          text = new TextEncoder(),
          hex = (bytes) =>
            Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(
              "",
            ),
          digest = async (bytes) => hex(await subtle.digest("SHA-256", bytes));
        const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
            "sign",
            "verify",
          ]),
          spki = await subtle.exportKey("spki", pair.publicKey);
        const value = {
          requestId: window.crypto.randomUUID(),
          name: `Portal ${window.crypto.randomUUID().slice(0, 8)}`,
          secret: hex(window.crypto.getRandomValues(new Uint8Array(32))),
          privateKey: await subtle.exportKey("jwk", pair.privateKey),
          devicePublicKey: ui.encode(spki),
        };
        const transcript = JSON.stringify([
          "omnesis-device-enrollment-v3",
          value.requestId,
          "portal",
          await digest(text.encode(value.name)),
          await digest(text.encode(value.secret)),
          await digest(spki),
        ]);
        const nonce = ui.encode(await subtle.digest("SHA-256", text.encode(transcript)));
        const { operationId } = await ui.api("portal/start", { nonce });
        value.operationId = operationId;
        window.sessionStorage.setItem(handoffKey, JSON.stringify(value));
        handoff = value;
      } catch {
        // Without a handoff the gateway asks for its own sign-in.
      }
    },
    /** A sign-in on the plain page also prepares the handoff, wherever the browser can keep one. */
    enter(google) {
      const signIn = () => (google ? ui.google(false) : ui.signIn());
      let capable = false;
      try {
        capable = Boolean(!operationKey && window.crypto.subtle && window.sessionStorage);
      } catch {
        // A browser that refuses storage signs in without a handoff.
      }
      return capable ? ui.prepare().then(signIn) : signIn();
    },
    /** Opens a gateway's portal, spending the handoff when this sign-in prepared one. */
    async open(gateway, replace = false) {
      let { href } = ui.portal(gateway);
      const value = handoff;
      // A handoff already on its way opens the gateway by itself.
      if (value?.opening) return;
      if (value) {
        value.opening = true;
        try {
          const result = await ui.api("portal/handoff", { gatewayId: gateway.gatewayId });
          const fragment = new TextEncoder().encode(
            JSON.stringify({
              v: 1,
              requestId: value.requestId,
              name: value.name,
              secret: value.secret,
              privateKey: value.privateKey,
              devicePublicKey: value.devicePublicKey,
              identityToken: result.identityToken,
              proof: result.signInProof,
            }),
          );
          href = `${ui.portal(result).href}#account-signin=${ui.encode(fragment)}`;
          ui.forget();
        } catch {
          // The plain link still opens the gateway, which then asks for its own sign-in.
        }
      }
      if (replace) window.location.replace(href);
      else window.location.assign(href);
    },
    /**
     * Removing or linking needs a recent sign-in, so a stale session is asked to confirm first.
     * Adding a passkey asks afterwards instead: the confirmation then vouches for the new passkey.
     */
    async change(intent) {
      const confirmFirst = intent.kind !== "add";
      if (confirmFirst && current.credentialsRequireSignIn) return ui.ask(intent);
      try {
        await ui.perform(intent);
      } catch (error) {
        // The confirmation can lapse while the page is open.
        if (
          confirmFirst &&
          error.name === "AccountSignInRequired" &&
          current.authenticated &&
          current.credentialsRequireSignIn
        )
          return ui.ask(intent);
        throw error;
      }
    },
    ask(intent) {
      confirming = intent;
      alert.textContent = "";
      ui.render();
    },
    async perform(intent) {
      confirming = undefined;
      if (intent.kind === "link") return ui.google(true);
      if (intent.kind === "remove") {
        failure = "The passkey could not be removed. Please try again.";
        await ui.api("passkeys/remove", { id: intent.id });
        await ui.refresh();
        return ui.say(
          current.authenticated
            ? "Passkey removed."
            : "Passkey removed. Sign in again to continue.",
        );
      }
      failure = "The passkey could not be added. Please try again.";
      let made;
      try {
        made = await ui.passkey(true);
      } catch (error) {
        const cancelled = error.name === "NotAllowedError" || error.name === "AbortError";
        if (!cancelled && error.name !== "InvalidStateError") throw error;
        notice = cancelled
          ? "No passkey was added."
          : "This device already has a passkey for your Omnesis account.";
        return ui.render();
      }
      // The passkey exists on this device; the account keeps it once it has signed for the
      // account's other sign-ins and one of them has vouched for it.
      endorsing = { id: made.endorse, credential: made.id, countersigned: false };
      ui.render();
    },
    /** Stores the new passkey once a sign-in the account already had has vouched for it. */
    async finishEndorsement(id) {
      failure = "The passkey could not be added. Please try again.";
      let added;
      try {
        added = await ui.api("passkeys/register/confirm", {}, id);
      } catch (error) {
        endorsing = undefined;
        await ui.refresh();
        throw error;
      }
      endorsing = undefined;
      fresh.add(added.id);
      await ui.refresh();
      ui.say("Passkey added. You can now use it to sign in.");
    },
    async endorse() {
      const { id } = endorsing;
      await ui.passkey(false, false, id);
      await ui.finishEndorsement(id);
    },
    /** The new passkey's own signature, which lets a gateway that trusts it trust the others. */
    async countersign() {
      failure = "The new passkey could not be used. Try again, or cancel.";
      await ui.passkey(false, false, endorsing.id, true);
      endorsing.countersigned = true;
      ui.render();
    },
    async cancelEndorsement() {
      const { id, credential } = endorsing;
      endorsing = undefined;
      // Best effort: the passkey was never stored, so its leftovers are only tidied up.
      await ui.api("passkeys/register/cancel", {}, id).catch(() => {});
      if (credential) await ui.forgetPasskey(credential);
      notice = "No passkey was added.";
      ui.render();
    },
    async confirm() {
      const intent = confirming;
      await ui.passkey(false);
      if (intent.kind === "unlink") {
        await ui.refresh();
        // Only the account the panel was opened on unlinks, and right away, as the panel said.
        const other = current.accountId !== intent.accountId,
          gone = !current.gateways.some((gateway) => gateway.gatewayId === intent.gatewayId);
        if (!other && !gone) return ui.unlinkGateway(intent);
        confirming = undefined;
        ui.render();
        return ui.say(
          other
            ? "You confirmed with a different Omnesis account. Nothing was unlinked."
            : "That gateway is no longer in your account.",
          "gateways",
        );
      }
      confirming = undefined;
      await ui.refresh();
      if (intent.kind === "delete") {
        // Deleting still takes its own press, and only for the account the panel was opened on.
        if (current.accountId === intent.accountId) return ui.ask(intent);
        return ui.say("You confirmed with a different Omnesis account. Nothing was deleted.");
      }
      // The passkey used may belong to another account, where this removal means nothing.
      if (
        intent.kind === "remove" &&
        !current.credentials.passkeys.some((credential) => credential.id === intent.id)
      )
        return;
      await ui.change(intent);
    },
    async deleteAccount() {
      const { accountId } = confirming,
        { passkeys } = current.credentials;
      failure = "Your account could not be deleted. Please try again.";
      try {
        await ui.api("delete", { accountId });
      } catch (error) {
        // The confirmation lapsed while the panel was open, so the panel asks for it again.
        if (error.name === "AccountSignInRequired") return;
        throw error;
      }
      confirming = undefined;
      ui.forget();
      for (const passkey of passkeys) await ui.forgetPasskey(passkey.id);
      await ui.refresh();
      ui.say("Your Omnesis account was deleted.");
    },
    /** Opens the in-page step before unlinking: what it does, and a confirmation if needed. */
    askUnlink(gateway) {
      ui.ask({
        kind: "unlink",
        accountId: current.accountId,
        gatewayId: gateway.gatewayId,
        name: gateway.displayName ?? "Gateway",
      });
      root.querySelector(".unlink h3")?.focus();
    },
    async unlinkGateway(intent = confirming) {
      failure = "The gateway could not be unlinked. Please try again.";
      // As the page last saw it, which a return to the tab may have changed since the question.
      const online = current.gateways.some(
        (gateway) => gateway.gatewayId === intent.gatewayId && gateway.online,
      );
      try {
        await ui.api("gateways/unlink", {
          accountId: intent.accountId,
          gatewayId: intent.gatewayId,
        });
      } catch (error) {
        // The confirmation lapsed while the panel was open, so the panel asks for it again.
        if (error.name === "AccountSignInRequired") return;
        if (error.status !== 404) throw error;
        confirming = undefined;
        await ui.refresh();
        return ui.say("That gateway is no longer in your account.", "gateways");
      }
      confirming = undefined;
      await ui.refresh();
      ui.say(
        online
          ? `“${intent.name}” was unlinked from your account.`
          : `“${intent.name}” was unlinked from your account. It shows as not connected the next time it comes online.`,
        "gateways",
      );
    },
    google(link, then, endorse) {
      const url = new URL("/_relay/web/start", window.location.origin);
      if (link) url.searchParams.set("link", "1");
      else if (endorse) url.searchParams.set("endorse", endorse);
      else if (then) url.searchParams.set("then", then);
      else if (openPortal) url.searchParams.set("open", "portal");
      if (operation) url.searchParams.set(operationKey, operation);
      else if (handoff && !link && !then && !endorse)
        url.searchParams.set("portal", handoff.operationId);
      window.location.assign(url.href);
    },
    async continueOperation() {
      let result;
      try {
        result = await ui.api("continue", {});
      } catch (error) {
        // The refusal may have changed what this page should offer, such as a fresh sign-in.
        await ui.refresh();
        throw error;
      }
      const url = new URL(result.location);
      // A desktop sign-in ends on the desktop's own loopback listener (RFC 8252 §7.3).
      const loopback =
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.pathname === "/omnesis/callback";
      if ((url.protocol !== "https:" && !loopback) || url.username || url.password)
        throw new Error("Invalid account handoff");
      window.location.assign(url.href);
    },
    /** `only` is the one sign-in the gateway's page already chose, when it chose one. */
    signInChoices(session, only) {
      if (only !== "google")
        ui.button(only ? methodCopy.passkey.action : "Sign in with Passkey", () => ui.enter(false));
      if (session.googleAvailable && only !== "passkey")
        ui.googleButton(
          only ? methodCopy.google.action : "Sign in with Google",
          () => ui.enter(true),
          !only,
        );
    },
    /** An account is created only from here, by the sign-in the person picks on this view. */
    createChoices(session, only) {
      const google = session.googleAvailable && only !== "passkey";
      if (google) ui.googleButton("Create with Google", () => ui.google(false));
      if (session.canCreateAccount && only !== "google")
        ui.button("Create with a passkey", () => ui.signIn(true), google);
      const note = ui.node(
        "p",
        "If this Google account already has an Omnesis account, you'll be signed in to it instead.",
      );
      note.className = "note";
      if (google) root.append(note);
    },
    /** The sign-in a gateway's page chose, if this page can offer it. */
    method(session) {
      const { method } = session.pending;
      return method === "passkey" || (method === "google" && session.googleAvailable)
        ? method
        : undefined;
    },
    async setIntent(intent) {
      await ui.api("intent", { intent });
      await ui.refresh();
    },
    denied(denied) {
      if (denied.inviteRequired) {
        root.append(...inviteNeeded.map((line) => ui.node("p", line)));
        return;
      }
      root.append(
        ui.node(
          "p",
          denied.reason === "capacity"
            ? "This service has no room for more gateways right now."
            : "This service isn't accepting your Omnesis account yet.",
        ),
      );
      root.append(ui.node("p", "Then start again from your gateway."));
    },
    pending(session) {
      const { pending } = session,
        copy = pendingCopy[pending.purpose],
        signedIn = session.authenticated && !pending.needsProof,
        creating = pending.intent === "create" && !signedIn && !pending.denied,
        only = signedIn || pending.denied ? undefined : ui.method(session),
        // Signing in with the one sign-in the gateway's page chose is the whole step.
        sole = !creating && only && methodCopy[only];
      root.append(
        ui.node(
          "h1",
          creating
            ? createCopy.title
            : sole
              ? sole.title
              : (signedIn && copy.readyTitle) || copy.title,
        ),
      );
      const name = ui.node("p", pending.deviceName ?? pending.gatewayName ?? pending.hostname);
      name.className = "pending-host";
      root.append(name);
      if (pending.denied) {
        ui.denied(pending.denied);
        return;
      }
      if (pending.code) {
        const code = ui.node("p", pending.code);
        code.className = "code";
        root.append(
          code,
          ui.node("p", "Only continue if you started this on that machine and the code matches."),
        );
      }
      if (creating && pending.canCreate === false) {
        root.append(...inviteNeeded.map((line) => ui.node("p", line)));
        ui.button("I already have an account", () => ui.setIntent("existing"));
        return;
      }
      if (creating) {
        root.append(...createCopy.lines.map((line) => ui.node("p", line)));
        ui.createChoices(session, only);
        ui.button("I already have an account", () => ui.setIntent("existing"), true);
        return;
      }
      if (!signedIn) {
        root.append(ui.node("p", sole ? sole.signIn : copy.signIn));
        ui.signInChoices(session, only);
        if (pending.intent)
          ui.button("Create an account instead", () => ui.setIntent("create"), true);
        return;
      }
      root.append(
        ui.node("p", pending.approvalRequired && copy.approval ? copy.approval : copy.ready),
      );
      ui.button(copy.action, ui.continueOperation);
      // Pairing this browser goes on without another press: signing in here was the decision. A
      // gateway is connected only by the press, after the person has compared its name and code,
      // since whoever started that request chose them. A failure leaves the button.
      if (copy.automatic && !continued) {
        continued = true;
        setTimeout(() => ui.run(ui.continueOperation), 0);
      }
    },
    portal(gateway) {
      const origin = new URL(gateway.publicOrigin);
      if (origin.protocol !== "https:" || origin.username || origin.password)
        throw new Error("Invalid gateway address");
      return { origin, href: new URL("/portal/", origin).href };
    },
    async refresh() {
      ui.show(await ui.api("session"));
    },
    show(session) {
      current = session;
      // A handoff is kept only for the sign-in that was made for it.
      if (handoff && !(current.authenticated && current.handoff?.ready)) ui.forget();
      ui.render();
    },
    render() {
      const session = current;
      root.replaceChildren();
      more = undefined;
      menus = [];
      if (
        openPortal &&
        session.authenticated &&
        !session.pending &&
        session.gateways.length === 1
      ) {
        let portal;
        try {
          portal = ui.portal(session.gateways[0]);
        } catch {
          // The account page below reports an address it cannot link to.
        }
        if (portal) {
          root.append(ui.node("p", "Opening your gateway…"));
          if (handoff) void ui.open(session.gateways[0], true);
          else window.location.replace(portal.href);
          return;
        }
      }
      ui.view(session);
      if (!root.contains(status)) root.querySelector("h1").after(status);
      status.textContent = notice;
    },
    row(title, details, isNew) {
      const text = document.createElement("span"),
        name = ui.node("span", title);
      text.className = "row-text";
      name.className = "row-title";
      if (isNew) {
        const badge = ui.node("span", "New");
        badge.className = "badge";
        name.append(" ", badge);
      }
      const meta = ui.node("span", details);
      meta.className = "row-meta";
      text.append(name, meta);
      return text;
    },
    confirmation(session, parent) {
      const panel = document.createElement("div"),
        hasPasskey = session.credentials.passkeys.length > 0;
      panel.className = "confirm";
      panel.append(
        ui.node("h3", "Confirm it's you"),
        ui.node(
          "p",
          "Changing how you sign in needs a fresh confirmation, so that someone else using this browser can't remove your passkeys.",
        ),
      );
      if (confirming.kind === "remove")
        panel.append(
          ui.node("p", `Confirming with a passkey removes “${confirming.label}” right away.`),
        );
      if (hasPasskey) ui.button("Confirm with passkey", ui.confirm, false, panel);
      if (
        session.googleAvailable &&
        session.credentials.federated.some((credential) => credential.provider === "google")
      )
        ui.googleButton(
          "Confirm with Google",
          () => ui.google(false, "remove-passkey"),
          hasPasskey,
          panel,
        );
      ui.button("Cancel", () => ui.ask(undefined), true, panel);
      parent.append(panel);
    },
    /** Under the gateway being unlinked: what unlinking does, then the one step that does it. */
    unlinkPanel(session, parent) {
      const panel = document.createElement("div"),
        title = ui.node("h3", `Unlink “${confirming.name}” from your account?`),
        hasPasskey = session.credentials.passkeys.length > 0;
      panel.className = "confirm unlink";
      title.tabIndex = -1;
      panel.append(title, ...unlinkLines.map((line) => ui.node("p", line)));
      if (session.credentialsRequireSignIn) {
        panel.append(
          ui.node(
            "p",
            hasPasskey
              ? "Unlinking needs a fresh confirmation, so that someone else using this browser can't unlink your gateways. Confirming with your passkey unlinks it right away."
              : "Unlinking needs a fresh confirmation, so that someone else using this browser can't unlink your gateways.",
          ),
        );
        if (hasPasskey) ui.button("Confirm with passkey", ui.confirm, false, panel);
        if (
          session.googleAvailable &&
          session.credentials.federated.some((credential) => credential.provider === "google")
        )
          ui.googleButton(
            "Confirm with Google",
            () => ui.google(false, "unlink-gateway"),
            hasPasskey,
            panel,
          );
      } else
        ui.button("Unlink gateway", () => ui.unlinkGateway(), false, panel).classList.add("danger");
      ui.button(
        "Cancel",
        () => {
          const { gatewayId } = confirming;
          ui.ask(undefined);
          // Back on the menu the question came from.
          [...root.querySelectorAll(".gateway-item")]
            .find((row) => row.dataset.gatewayId === gatewayId)
            ?.querySelector(".more-button")
            .focus();
        },
        true,
        panel,
      );
      parent.append(panel);
    },
    /** Whether the relay holds a live connection to the gateway: a dot and the word, never colour alone. */
    presence(online) {
      const element = ui.node("span", online ? "Online" : "Offline");
      element.className = online ? "presence online" : "presence";
      return element;
    },
    /**
     * Takes the place of the account view: says what deleting does, asks for a fresh confirmation
     * if needed, then for one last press.
     */
    deletion(session) {
      const title = ui.node("h1", "Delete your Omnesis account?"),
        panel = document.createElement("section"),
        list = document.createElement("ul"),
        hasPasskey = session.credentials.passkeys.length > 0;
      panel.className = "delete-account";
      list.append(...deletionLines.map((line) => ui.node("li", line)));
      panel.append(
        ui.node(
          "p",
          "Disconnects your gateways from this account and deletes everything this service stores about it.",
        ),
        list,
      );
      if (session.credentialsRequireSignIn) {
        panel.append(
          ui.node("h2", "Confirm it's you"),
          ui.node(
            "p",
            "Deleting your account needs a fresh confirmation, so that someone else using this browser can't delete it. Nothing is deleted until you press Delete account afterwards.",
          ),
        );
        if (hasPasskey) ui.button("Confirm with passkey", ui.confirm, false, panel);
        if (
          session.googleAvailable &&
          session.credentials.federated.some((credential) => credential.provider === "google")
        )
          ui.googleButton(
            "Confirm with Google",
            () => ui.google(false, "delete-account"),
            hasPasskey,
            panel,
          );
      } else
        ui.button("Delete account permanently", ui.deleteAccount, false, panel).classList.add(
          "danger",
        );
      ui.button(
        "Cancel",
        () => {
          ui.ask(undefined);
          // Back where the person came from.
          more.trigger.focus();
        },
        true,
        panel,
      );
      root.append(title, panel);
      // The view replaced what had the focus, so reading resumes at its question.
      title.tabIndex = -1;
      title.focus();
    },
    /** Opens or closes a menu, closing any other; closing can hand the focus back to its button. */
    toggleMenu(menu, open, focus) {
      if (open) for (const other of menus) if (other !== menu) ui.toggleMenu(other, false);
      menu.list.hidden = !open;
      menu.trigger.setAttribute("aria-expanded", String(open));
      if (open) menu.list.firstChild.focus();
      else if (focus) menu.trigger.focus();
    },
    /**
     * A "more" button and the menu it opens, drawn by the stylesheet as three dots. `items` are
     * `[text, action, className]`; choosing one closes the menu first.
     */
    dropdown(label, items, className) {
      const wrapper = document.createElement("div"),
        trigger = document.createElement("button"),
        list = document.createElement("div");
      wrapper.className = className;
      trigger.type = "button";
      trigger.className = "more-button";
      trigger.setAttribute("aria-label", label);
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.append(
        document.createElement("span"),
        document.createElement("span"),
        document.createElement("span"),
      );
      list.className = "more-list";
      list.setAttribute("role", "menu");
      list.setAttribute("aria-label", label);
      wrapper.append(trigger, list);
      const menu = { wrapper, trigger, list };
      menus.push(menu);
      ui.toggleMenu(menu, false);
      // Not an action: opening the menu leaves any message on the page alone.
      trigger.addEventListener("click", () => ui.toggleMenu(menu, list.hidden));
      wrapper.addEventListener("keydown", (event) => {
        if (list.hidden) return;
        if (event.key === "Escape") ui.toggleMenu(menu, false, true);
        else if (event.key === "Tab") ui.toggleMenu(menu, false);
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const entries = [...list.children],
            step = event.key === "ArrowDown" ? 1 : entries.length - 1;
          entries[(entries.indexOf(event.target) + step) % entries.length].focus();
        }
      });
      for (const [text, action, itemClass] of items) {
        const element = ui.button(
          text,
          () => {
            ui.toggleMenu(menu, false);
            return action();
          },
          false,
          list,
        );
        element.setAttribute("role", "menuitem");
        if (itemClass) element.className = itemClass;
      }
      return menu;
    },
    /** The two things done to the account as a whole, kept out of the way behind one button. */
    menu(session) {
      more = ui.dropdown(
        "More options",
        [
          [
            "Sign out",
            async () => {
              await ui.api("logout", {});
              await ui.refresh();
            },
          ],
          [
            "Delete account",
            () => ui.ask({ kind: "delete", accountId: session.accountId }),
            "danger",
          ],
        ],
        "more",
      );
      root.append(more.wrapper);
    },
    /**
     * The rest of adding a passkey: the new passkey signs for the sign-ins the account already
     * has, then one of those vouches for it.
     */
    endorsement(session, parent) {
      const panel = document.createElement("div"),
        hasPasskey = session.credentials.passkeys.length > 0;
      panel.className = "confirm";
      if (!endorsing.countersigned) {
        panel.append(
          ui.node("h3", "Use your new passkey once"),
          ui.node(
            "p",
            "Your new passkey is ready. Use it once now, so that your gateways can tell it belongs with the sign-in methods you already have.",
          ),
        );
        ui.button("Use new passkey", ui.countersign, false, panel);
        ui.button("Cancel", ui.cancelEndorsement, true, panel);
        parent.append(panel);
        return;
      }
      panel.append(
        ui.node("h3", "Confirm it's you to finish"),
        ui.node(
          "p",
          "Now confirm with a sign-in you already use, so that someone else using this browser can't add their own passkey. Your gateways check both steps themselves before they trust a sign-in.",
        ),
      );
      if (hasPasskey) ui.button("Confirm with passkey", ui.endorse, false, panel);
      if (
        session.googleAvailable &&
        session.credentials.federated.some((credential) => credential.provider === "google")
      )
        ui.googleButton(
          "Confirm with Google",
          () => ui.google(false, undefined, endorsing.id),
          hasPasskey,
          panel,
        );
      ui.button("Cancel", ui.cancelEndorsement, true, panel);
      parent.append(panel);
    },
    view(session) {
      // Only the account itself uses the full column; a sign-in or an operation stays narrow.
      root.parentNode.classList.toggle("wide", Boolean(session.authenticated && !session.pending));
      if (session.pending) {
        ui.pending(session);
        return;
      }
      if (!session.authenticated) {
        confirming = undefined;
        endorsing = undefined;
        fresh.clear();
        root.append(ui.node("h1", "Sign in to your Omnesis account"));
        ui.signInChoices(session);
        return;
      }
      if (confirming?.kind === "delete") return ui.deletion(session);
      ui.menu(session);
      root.append(ui.node("h1", "Your Omnesis account"));
      const section = (title) => {
        const element = document.createElement("section");
        element.append(ui.node("h2", title));
        root.append(element);
        return element;
      };
      const owned = section("Your gateways");
      gatewaysSection = owned;
      if (session.gateways.length === 0)
        owned.append(
          ui.node(
            "p",
            "No gateways are connected to your Omnesis account. Connect one from its settings.",
          ),
        );
      const gateways = document.createElement("div");
      gateways.className = "list";
      // A gateway unlinked meanwhile, such as from another browser, takes its panel with it.
      if (
        confirming?.kind === "unlink" &&
        !session.gateways.some((gateway) => gateway.gatewayId === confirming.gatewayId)
      )
        confirming = undefined;
      for (const gateway of session.gateways) {
        const { origin, href } = ui.portal(gateway);
        const name = gateway.displayName ?? "Gateway";
        const item = document.createElement("div");
        item.className = "gateway-item";
        const link = document.createElement("a");
        link.href = href;
        link.className = "gateway";
        link.title = origin.hostname;
        const text = ui.row(name, origin.hostname, false);
        text.append(ui.presence(gateway.online));
        link.append(text);
        if (handoff)
          link.addEventListener("click", (event) => {
            event.preventDefault();
            ui.run(() => ui.open(gateway));
          });
        item.append(
          link,
          ui.dropdown(
            `More actions for “${name}”`,
            [["Unlink from account", () => ui.askUnlink(gateway)]],
            "row-more",
          ).wrapper,
        );
        item.dataset.gatewayId = gateway.gatewayId;
        gateways.append(item);
        if (confirming?.kind === "unlink" && confirming.gatewayId === gateway.gatewayId)
          ui.unlinkPanel(session, gateways);
      }
      if (session.gateways.length > 0) owned.append(gateways);
      if (noticeAt === "gateways") owned.append(status);
      const signIn = section("Sign-in methods"),
        hasGoogle = session.credentials.federated.some(
          (credential) => credential.provider === "google",
        ),
        methods = document.createElement("div");
      methods.className = "list";
      for (const credential of session.credentials.federated) {
        const row = document.createElement("div");
        row.className = "credential";
        row.append(
          ui.row(
            credential.provider === "google" ? "Google" : credential.provider,
            `Linked ${ui.date(credential.createdAt)}`,
            fresh.has(`provider:${credential.provider}`),
          ),
        );
        methods.append(row);
      }
      for (const credential of session.credentials.passkeys) {
        const row = document.createElement("div");
        row.className = "credential";
        row.append(
          ui.row(
            credential.label,
            [
              `Added ${ui.date(credential.createdAt)}`,
              credential.lastUsedAt ? `Last used ${ui.date(credential.lastUsedAt)}` : "Never used",
              credential.backedUp
                ? "Synced"
                : credential.deviceType === "singleDevice"
                  ? "One device only"
                  : "",
            ]
              .filter(Boolean)
              // A line breaks between two facts, never inside one.
              .map((fact) => fact.replaceAll(" ", "\u00a0"))
              .join("\u00a0· "),
            fresh.has(credential.id),
          ),
        );
        const remove = ui.button(
          "Remove",
          () => ui.change({ kind: "remove", id: credential.id, label: credential.label }),
          true,
          row,
        );
        if (session.credentials.passkeys.length === 1 && !(session.googleAvailable && hasGoogle)) {
          remove.dataset.unavailable = "1";
          remove.disabled = true;
          remove.title = "Keep at least one sign-in method";
        }
        methods.append(row);
      }
      signIn.append(methods);
      if (noticeAt !== "gateways") signIn.append(status);
      if (endorsing) ui.endorsement(session, signIn);
      else if (confirming && confirming.kind !== "unlink") ui.confirmation(session, signIn);
      else {
        // Quiet on purpose: adding a sign-in method is occasional, not what the page is for.
        const actions = document.createElement("div");
        actions.className = "list-actions";
        ui.button("Add a passkey", () => ui.change({ kind: "add" }), true, actions).className =
          "quiet add";
        if (session.googleAvailable && !hasGoogle)
          ui.googleButton(
            "Link Google",
            () => ui.change({ kind: "link" }),
            true,
            actions,
          ).className = "quiet";
        signIn.append(actions);
      }
    },
  };
  document.addEventListener("click", (event) => {
    // A press anywhere else closes the menu, and a press on nothing gives its button the focus back.
    for (const menu of menus)
      if (!menu.list.hidden && !menu.wrapper.contains(event.target))
        ui.toggleMenu(menu, false, !event.target.closest("a,button"));
  });
  ui.run(async () => {
    ui.restore();
    await ui.refresh();
    if (query.get("failed") === "google")
      alert.textContent = "Google sign-in did not complete. Try again or use a passkey.";
    if (query.get("failed") === "again") ui.say(googleAgain);
    if (query.get("failed") === "invite") alert.textContent = inviteUnusable;
    if (query.get("failed") === "no-account")
      alert.textContent = current.pending?.intent
        ? `${noAccount} You can create one below.`
        : `${noAccount} Create one from your gateway: open its portal, then Settings and Omnesis account.`;
    const linked = query.get("linked") === "google",
      thens = query.getAll("then"),
      endorsed = query.getAll("endorse");
    if (query.has("linked") || query.has("then") || query.has("endorse")) {
      // A reload must not repeat the message or the change.
      query.delete("linked");
      query.delete("then");
      query.delete("endorse");
      const rest = query.toString();
      window.history.replaceState(null, "", "/_relay/account" + (rest ? `?${rest}` : ""));
    }
    if (operationKey || openPortal || !current.authenticated) return;
    if (endorsed.length === 1) {
      // Back from Google, which either vouched for the new passkey or did not complete.
      if (!query.has("failed")) return ui.finishEndorsement(endorsed[0]);
      // The new passkey signed before the person chose Google.
      endorsing = { id: endorsed[0], countersigned: true };
      return ui.render();
    }
    if (current.credentialsRequireSignIn) return;
    if (
      linked &&
      current.credentials.federated.some((credential) => credential.provider === "google")
    ) {
      fresh.add("provider:google");
      notice = "Google linked. You can now sign in with Google.";
      ui.render();
    }
    if (thens.length === 1 && thens[0] === "remove-passkey")
      ui.say("Confirmed. You can remove it now.");
    if (thens.length === 1 && thens[0] === "delete-account")
      ui.say("Confirmed. You can delete your account now.");
    if (thens.length === 1 && thens[0] === "unlink-gateway")
      ui.say("Confirmed. You can unlink it now.", "gateways");
  });
  document.addEventListener("visibilitychange", () => {
    // Back on the tab, whether each gateway is online is read again; nothing polls in between.
    if (
      document.visibilityState !== "visible" ||
      busy ||
      operationKey ||
      openPortal ||
      !current?.authenticated ||
      current.pending
    )
      return;
    const seen = generation;
    ui.api("session")
      .then((session) => {
        if (!busy && generation === seen) ui.show(session);
      })
      .catch(() => {
        // The next action reports a problem; a background refresh says nothing.
      });
  });
}

/** Self-contained for the same reason as above: served as one function under a self-only CSP. */
export function installConnectUI() {
  const form = document.getElementById("connect-form");
  const input = document.getElementById("connect-code");
  const alert = document.getElementById("account-error");
  const button = form.querySelector("button");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    alert.textContent = "";
    button.disabled = true;
    try {
      const response = await fetch("/_relay/v3/connect/claim", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: input.value }),
      });
      if (response.status === 429)
        throw new Error("Too many tries. Wait a minute, then try again.");
      if (response.status === 409)
        throw new Error(
          "This code was already used in another browser. Finish there, or start again on your machine.",
        );
      if (!response.ok)
        throw new Error("That code didn't work. Check it, or start again on your machine.");
      const { location } = await response.json();
      const url = new URL(location, window.location.origin);
      if (url.origin !== window.location.origin)
        throw new Error("Something went wrong. Try again.");
      window.location.assign(url.href);
    } catch (error) {
      alert.textContent =
        error instanceof TypeError ? "Something went wrong. Try again." : error.message;
      button.disabled = false;
    }
  });
}

/** The invite page: says whether the invite in the link still works, and lets the person copy it. */
export function installInviteUI() {
  const status = document.getElementById("invite-status");
  const value = document.getElementById("invite-value");
  const copy = document.getElementById("invite-copy");
  const say = (text) => {
    status.textContent = text;
  };
  const messages = {
    invalid: "This invite isn't valid. Check that you copied the whole link.",
    expired: "This invite has expired. Ask for a new one.",
    used: "This invite was already used to create an account. Ask for a new one.",
  };
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Select the invite above and copy it";
    }
  });
  // Pasting another link into the address bar changes only the fragment, which reloads nothing,
  // so the page checks again on every change and shows only the newest answer.
  let latest = 0;
  const check = () => {
    const attempt = ++latest;
    const invite = window.location.hash.slice(1);
    copy.textContent = "Copy invite";
    if (!invite) {
      value.textContent = "";
      copy.hidden = true;
      say("This link has no invite in it. Ask whoever sent it for the whole link.");
      return;
    }
    value.textContent = window.location.href;
    copy.hidden = false;
    say("Checking your invite…");
    fetch("/_relay/v3/signup/invite", {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (attempt !== latest) return;
        if (result.status === "valid") {
          const until = new Date(result.expiresAt * 1000).toLocaleDateString(undefined, {
            dateStyle: "long",
          });
          say(`This invite works until ${until}.`);
        } else say(messages[result.status] ?? messages.invalid);
      })
      .catch(() => {
        if (attempt === latest)
          say("We couldn't check this invite right now. You can still use it.");
      });
  };
  window.addEventListener("hashchange", check);
  check();
}
