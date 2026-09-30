// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Blog controls and reader-initiated GitHub comments. No Giscus request is
// made until the reader asks to load the discussion.
(function () {
  "use strict";

  var root = document.documentElement;
  var toggle = document.getElementById("theme-toggle");
  var nav = document.getElementById("nav");
  var lightQuery = window.matchMedia("(prefers-color-scheme: light)");

  function storedTheme() {
    try {
      var theme = localStorage.getItem("omnesis-theme");
      return theme === "light" || theme === "dark" ? theme : null;
    } catch (_error) {
      return null;
    }
  }

  function syncTheme() {
    var light = root.getAttribute("data-theme") === "light";
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.setAttribute("content", light ? "#ffffff" : "#0d1117");
    });
    if (toggle) {
      toggle.setAttribute("aria-label", "Switch to " + (light ? "dark" : "light") + " theme");
    }
    var frame = document.querySelector("#giscus-container iframe.giscus-frame");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(
        { giscus: { setConfig: { theme: light ? "light" : "dark" } } },
        "https://giscus.app",
      );
    }
  }

  root.classList.add("js");
  root.setAttribute("data-theme", storedTheme() || (lightQuery.matches ? "light" : "dark"));
  syncTheme();
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem("omnesis-theme", next);
      } catch (_error) {
        // The theme still works when browser storage is unavailable.
      }
      syncTheme();
    });
  }
  function followSystemTheme(event) {
    if (!storedTheme()) {
      root.setAttribute("data-theme", event.matches ? "light" : "dark");
      syncTheme();
    }
  }
  if (lightQuery.addEventListener) lightQuery.addEventListener("change", followSystemTheme);
  else lightQuery.addListener(followSystemTheme);

  function onScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 40);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var burger = document.getElementById("nav-burger");
  if (nav && burger) {
    function closeMenu() {
      nav.classList.remove("menu-open");
      burger.setAttribute("aria-expanded", "false");
      burger.setAttribute("aria-label", "Open navigation menu");
    }
    burger.addEventListener("click", function () {
      var open = nav.classList.toggle("menu-open");
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", (open ? "Close" : "Open") + " navigation menu");
    });
    nav.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("menu-open")) {
        closeMenu();
        burger.focus();
      }
    });
    nav.querySelectorAll(".nav-links a").forEach(function (link) {
      link.addEventListener("click", closeMenu);
    });
  }

  var comments = document.getElementById("comments");
  var button = document.getElementById("load-comments");
  var container = document.getElementById("giscus-container");
  var status = document.getElementById("comments-status");
  if (!comments || !button || !container || !status) return;

  var state = "idle";
  var timer;
  var required = ["giscusRepo", "giscusRepoId", "giscusCategory", "giscusCategoryId", "giscusTerm"];

  function cleanup() {
    clearTimeout(timer);
    container.replaceChildren();
    container.removeAttribute("aria-busy");
  }

  function fail() {
    state = "failed";
    cleanup();
    button.hidden = false;
    button.disabled = false;
    button.textContent = "Try loading comments again";
    status.textContent = "Comments could not load. Please retry or open the discussion on GitHub.";
  }

  function ready() {
    if (state !== "loading") return;
    state = "ready";
    clearTimeout(timer);
    container.removeAttribute("aria-busy");
    button.hidden = true;
    status.textContent = "";
    syncTheme();
  }

  window.addEventListener("message", function (event) {
    var frame = container.querySelector("iframe.giscus-frame");
    if (event.origin !== "https://giscus.app" || !frame || event.source !== frame.contentWindow)
      return;
    if (!event.data || !event.data.giscus) return;
    if (event.data.giscus.error) {
      // A new post has no discussion until its first interaction.
      if (String(event.data.giscus.error).indexOf("Discussion not found") === -1) fail();
      else ready();
    } else if (event.data.giscus.resizeHeight) {
      ready();
    }
  });

  button.addEventListener("click", function () {
    if (state === "loading" || state === "ready") return;
    if (
      !required.every(function (key) {
        return Boolean(comments.dataset[key]);
      })
    ) {
      status.textContent = "Comments are not configured yet.";
      return;
    }
    cleanup();
    state = "loading";
    button.disabled = true;
    button.textContent = "Loading comments…";
    status.textContent = "Connecting to GitHub comments…";
    container.setAttribute("aria-busy", "true");

    var script = document.createElement("script");
    script.src = "https://giscus.app/client.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    var settings = {
      repo: comments.dataset.giscusRepo,
      "repo-id": comments.dataset.giscusRepoId,
      category: comments.dataset.giscusCategory,
      "category-id": comments.dataset.giscusCategoryId,
      mapping: "specific",
      term: comments.dataset.giscusTerm,
      strict: "1",
      "reactions-enabled": "1",
      "emit-metadata": "0",
      "input-position": "top",
      theme: root.getAttribute("data-theme") === "light" ? "light" : "dark",
      lang: "en",
      loading: "eager",
    };
    Object.keys(settings).forEach(function (key) {
      script.setAttribute("data-" + key, settings[key]);
    });
    script.addEventListener("error", fail, { once: true });
    timer = setTimeout(fail, 20000);
    container.appendChild(script);
  });
})();
