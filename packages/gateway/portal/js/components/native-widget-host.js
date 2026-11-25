// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Public, isolated renderer host. No portal application, administrative API,
// bearer credential, session cookie, or arbitrary native operation is exposed.
export function widgetOrigin(value, websocket = false) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(https:|wss:)\/\/(\*\.)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/i,
  );
  if (!match || (!websocket && match[1].toLowerCase() !== "https:")) return null;
  if (match[4] && (Number(match[4].slice(1)) < 1 || Number(match[4].slice(1)) > 65535)) return null;
  return value;
}

export function widgetPolicy(origins = {}) {
  const list = (key, websocket = false) =>
    (Array.isArray(origins[key]) ? origins[key] : [])
      .map((value) => widgetOrigin(value, websocket))
      .filter(Boolean)
      .join(" ");
  return [
    "default-src 'none'",
    `script-src 'self' ${list("script")}`,
    `frame-src ${list("frame") || "'none'"}`,
    `connect-src 'self' ${list("connect", true)}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function rendererPath(kind, renderers) {
  if (typeof kind !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(kind))
    throw new Error("Invalid widget kind");
  const expected = `/portal/widget-renderers/${encodeURIComponent(kind)}/module.js`;
  if (renderers?.[kind] !== expected) throw new Error("Widget renderer is unavailable");
  return expected;
}

export function createWidgetHost({ document, fetch, load, send }) {
  let started = false;
  let stopped = false;
  let cleanup;
  const stop = () => {
    stopped = true;
    if (typeof cleanup === "function") {
      try {
        cleanup();
      } catch {
        /* provider cleanup is best effort */
      }
    }
    cleanup = undefined;
  };
  return {
    stop,
    async start(config) {
      if (started) return;
      started = true;
      const nonce = config?.nonce;
      const emit = (type, extra = {}) => {
        if (!stopped) send({ nonce, type, ...extra });
      };
      try {
        if (
          typeof nonce !== "string" ||
          !/^[a-f0-9]{64}$/.test(nonce) ||
          !config.payload ||
          Object.values(config.payload).some((v) => typeof v !== "string")
        )
          throw new Error("Invalid widget configuration");
        const policy = document.createElement("meta");
        policy.httpEquiv = "Content-Security-Policy";
        policy.content = widgetPolicy(config.origins);
        document.head.appendChild(policy);
        const response = await fetch("/portal/widget-renderers.json", {
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        });
        if (!response.ok) throw new Error("Widget renderer is unavailable");
        const path = rendererPath(config.kind, (await response.json()).renderers);
        const renderer = await load(path);
        if (stopped) return;
        if (typeof renderer.open !== "function") throw new Error("Widget renderer is unavailable");
        cleanup = await renderer.open({
          payload: config.payload,
          onResult: (token, metadata) => {
            if (
              typeof token !== "string" ||
              !token ||
              new TextEncoder().encode(token).byteLength > 16384
            ) {
              emit("error");
              return;
            }
            const detail = metadata ?? {};
            if (typeof detail !== "object" || Array.isArray(detail)) {
              emit("error");
              return;
            }
            let encoded;
            try {
              encoded = JSON.stringify(detail);
            } catch {
              emit("error");
              return;
            }
            if (
              typeof encoded !== "string" ||
              new TextEncoder().encode(encoded).byteLength > 65536
            ) {
              emit("error");
              return;
            }
            emit("result", { token, metadata: detail });
          },
          onExit: (message) => emit(message ? "error" : "exit"),
          onError: () => emit("error"),
        });
        if (stopped) stop();
        const status = document.getElementById("widget-status");
        if (status) status.textContent = "Complete the account connection in the secure window.";
      } catch {
        emit("error");
      }
    },
  };
}

if (typeof window !== "undefined" && window.webkit?.messageHandlers?.omnesisWidget) {
  window.omnesisWidgetHost = createWidgetHost({
    document: window.document,
    fetch: window.fetch.bind(window),
    load: (path) => import(path),
    send: (message) => window.webkit.messageHandlers.omnesisWidget.postMessage(message),
  });
  window.addEventListener("pagehide", () => window.omnesisWidgetHost.stop());
}
