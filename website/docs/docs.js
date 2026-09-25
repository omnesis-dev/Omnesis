// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/* Shared docs-page behavior: frosted nav on scroll + theme toggle.
   Mirrors the landing page's inline script (minus landing-only hooks). */
(function () {
  // .js on <html> tells the stylesheet that the injected controls (burger,
  // "On this page") exist; without it the static fallbacks show. The head
  // script sets it before first paint; this covers a page without one.
  var root = document.documentElement;
  if (root && root.classList) root.classList.add("js");

  // The theme is the reader's stored choice, else the OS preference. The head
  // script resolves it before first paint; here it follows OS changes while
  // nothing is stored, and keeps the browser chrome colour in step.
  var THEME_COLOR = { dark: "#0d1117", light: "#ffffff" };
  function storedTheme() {
    try {
      var t = localStorage.getItem("omnesis-theme");
      return t === "light" || t === "dark" ? t : null;
    } catch (e) {
      return null;
    }
  }
  function syncThemeColor() {
    if (!root || !root.getAttribute || !document.querySelectorAll) return;
    var color = THEME_COLOR[root.getAttribute("data-theme") === "light" ? "light" : "dark"];
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.setAttribute("content", color);
    });
  }
  syncThemeColor();
  if (root && root.setAttribute && typeof window.matchMedia === "function") {
    var lightQuery = window.matchMedia("(prefers-color-scheme: light)");
    var followOs = function (event) {
      if (storedTheme()) return;
      root.setAttribute("data-theme", event.matches ? "light" : "dark");
      syncThemeColor();
    };
    if (lightQuery.addEventListener) lightQuery.addEventListener("change", followOs);
    else if (lightQuery.addListener) lightQuery.addListener(followOs);
  }

  // Sections that moved to another page or anchor. URLs printed by released
  // binaries and installers, and readers' bookmarks, still name the old
  // place, so a hash this page no longer carries is forwarded to the new one.
  var MOVED = {
    "/docs/operating": {
      "hardened-gateway": "/docs/security#hardened-gateway",
      tls: "/docs/security#tls",
      backup: "/docs/updating#backup",
      updating: "/docs/updating#updating",
      "adopt-source": "/docs/updating#adopt-source",
      "docker-update": "/docs/updating#docker-update",
      "fleet-update": "/docs/updating#fleet-update",
      compatibility: "/docs/updating#compatibility",
    },
    "/docs/agent": {
      "privacy-policy": "/docs/connect#privacy-policy",
      "bring-your-own-agent": "/docs/connect#bring-your-own-agent",
      "openclaw-hermes": "/docs/connect#openclaw-hermes",
      "custom-agents": "/docs/connect#custom-agents",
      "help-and-security": "/docs/#help",
    },
    "/docs/experimental": {
      plaid: "/docs/sources#plaid",
      "local-files": "/docs/sources#local-files",
    },
    "/docs/setup": {
      gateway: "/docs/setup#certificates",
      "multiple-machines": "/docs/setup#tokens",
    },
    "/docs/sources": { removing: "/docs/sources#removing-a-source" },
  };
  var hash = window.location.hash ? window.location.hash.slice(1) : "";
  var movedTo = hash && MOVED[window.location.pathname.replace(/\.html$/, "")];
  if (movedTo && movedTo[hash] && !document.getElementById(hash)) {
    window.location.replace(movedTo[hash]);
  }

  var nav = document.getElementById("nav");
  var navLinks = nav && nav.querySelector(".nav-links");
  var path = window.location.pathname;
  var docsPage = path === "/docs" || path.indexOf("/docs/") === 0;
  if (navLinks && !navLinks.id) navLinks.id = "primary-navigation";
  if (navLinks) {
    navLinks.innerHTML =
      '<li><a href="/"' +
      (path === "/" ? ' aria-current="page"' : "") +
      ">Context Layer</a></li>" +
      '<li><a href="/brain"' +
      (path === "/brain" || path === "/brain.html" ? ' aria-current="page"' : "") +
      ">Omnesis Brain</a></li>" +
      '<li><a href="/vision"' +
      (path === "/vision" || path === "/vision.html" ? ' aria-current="page"' : "") +
      ">Vision</a></li>" +
      (docsPage ? '<li><a href="/docs/" aria-current="page">Docs</a></li>' : "");
  }

  var footerLinks = document.querySelector(".site-footer .footer-links");
  if (footerLinks) {
    footerLinks.innerHTML =
      (docsPage ? '<a href="/docs/">Docs</a>' : "") +
      '<a href="/privacy">Privacy</a>' +
      '<a class="footer-mail" href="mailto:contact@omnesis.dev" aria-label="Email Omnesis support">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>' +
      "contact@omnesis.dev</a>" +
      '<a class="footer-gh" href="#" data-oss-open>' +
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>GitHub</a>' +
      '<a class="footer-social footer-x" href="https://x.com/Omnesisdev" target="_blank" rel="noopener noreferrer" aria-label="Omnesis on X"><span class="footer-social-icon" aria-hidden="true"></span>@Omnesisdev</a>' +
      '<a class="footer-social footer-discord" href="https://discord.gg/4Y8pQHrVv" target="_blank" rel="noopener noreferrer" aria-label="Join Omnesis on Discord"><span class="footer-social-icon" aria-hidden="true"></span>Discord</a>';
  }

  function onScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 40);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var navRight = nav && nav.querySelector(".nav-right");
  if (navRight && !navRight.querySelector(".nav-icon-btn")) {
    var github = document.createElement("a");
    github.className = "nav-icon-btn";
    github.href = "#";
    github.setAttribute("data-oss-open", "");
    github.setAttribute("aria-label", "Omnesis on GitHub");
    github.title = "Omnesis on GitHub";
    github.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';
    navRight.appendChild(github);
  }

  var toggle = document.getElementById("theme-toggle");
  if (navRight && !toggle) {
    toggle = document.createElement("button");
    toggle.id = "theme-toggle";
    toggle.className = "theme-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Switch between dark and light theme");
    toggle.title = "Toggle theme";
    toggle.innerHTML =
      '<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>' +
      '<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    navRight.appendChild(toggle);
  }
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      syncThemeColor();
      try {
        localStorage.setItem("omnesis-theme", next);
      } catch (e) {
        /* private mode — theme just won't persist */
      }
    });
  }

  var burger = document.getElementById("nav-burger");
  if (navRight && !burger) {
    burger = document.createElement("button");
    burger.id = "nav-burger";
    burger.className = "nav-burger";
    burger.type = "button";
    burger.setAttribute("aria-label", "Open navigation menu");
    burger.setAttribute("aria-controls", "primary-navigation");
    burger.setAttribute("aria-expanded", "false");
    burger.innerHTML =
      '<svg class="icon-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>' +
      '<svg class="icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>';
    navRight.appendChild(burger);
  }
  if (nav && burger) {
    burger.addEventListener("click", function () {
      var open = nav.classList.toggle("menu-open");
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
    });
    nav.querySelectorAll(".nav-links a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("menu-open");
        burger.setAttribute("aria-expanded", "false");
        burger.setAttribute("aria-label", "Open navigation menu");
      });
    });
  }
})();

/* "Getting ready for open source" modal. The repo is not public yet, so the
   GitHub buttons (marked data-oss-open) open this instead of linking out. Defined
   once here and injected into every docs page that loads this script. */
(function () {
  if (!document.body) return;
  var MODAL_HTML =
    '<div id="oss-modal" class="oss-modal" role="dialog" aria-modal="true" aria-labelledby="oss-modal-title" hidden>' +
    '<div class="oss-modal__backdrop" data-oss-close></div>' +
    '<div class="oss-modal__card">' +
    '<button class="oss-modal__close" type="button" aria-label="Close" data-oss-close>&times;</button>' +
    '<h2 id="oss-modal-title" class="oss-modal__title">Getting ready for open source</h2>' +
    "<p class=\"oss-modal__body\">We're putting the finishing touches on Omnesis. Leave your email and we'll tell you the moment the repo goes public &mdash; plus major releases and new sources.</p>" +
    '<form class="oss-modal__form" id="oss-form" action="https://app.kit.com/forms/9517046/subscriptions" method="post">' +
    '<input class="oss-modal__input" type="email" name="email_address" placeholder="you@example.com" required aria-label="Email address" />' +
    '<button class="oss-modal__btn" type="submit">Notify me</button>' +
    "</form>" +
    '<p class="oss-modal__note">A few emails a year, no spam.</p>' +
    '<div class="oss-modal__ok" id="oss-ok">&#10003; You\'re on the list &mdash; we\'ll email you the moment Omnesis is public.</div>' +
    "</div></div>";
  document.body.insertAdjacentHTML("beforeend", MODAL_HTML);

  var modal = document.getElementById("oss-modal");
  var input = modal.querySelector('input[name="email_address"]');
  var lastFocus = null;
  function open(e) {
    if (e) e.preventDefault();
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(function () {
      if (input) input.focus();
    }, 40);
  }
  function close() {
    modal.hidden = true;
    document.body.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.querySelectorAll("[data-oss-open]").forEach(function (a) {
    a.addEventListener("click", open);
  });
  modal.querySelectorAll("[data-oss-close]").forEach(function (el) {
    el.addEventListener("click", close);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.hidden) close();
  });

  // Kit (ConvertKit) subscribe — fire-and-forget (no CORS headers), falling back
  // to a native submit if the request rejects. Same approach as the landing page.
  var form = document.getElementById("oss-form");
  var ok = document.getElementById("oss-ok");
  var note = modal.querySelector(".oss-modal__note");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = input && input.value.trim();
    if (!email) return;
    function done() {
      form.style.display = "none";
      if (note) note.style.display = "none";
      ok.style.display = "block";
    }
    fetch(form.action, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email_address: email }),
    })
      .then(done)
      .catch(function () {
        form.submit();
      });
  });
})();

/* Copy button on every terminal card. What lands on the clipboard is what the
   card shows, minus the chrome: its commands in document order, each `# …`
   line that marks one of them as an alternative, and nothing else — no prompt
   glyph, no printed result, no dimmed output line. A card that shows no
   command copies its <pre> payload verbatim instead. */
(function () {
  // No DOM to decorate, or an insecure origin with no clipboard to offer.
  if (!document.body || !navigator.clipboard) return;
  var ICONS =
    '<svg class="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/></svg>' +
    '<svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function payload(term) {
    var body = term.querySelector(".term-body");
    if (!body) return "";
    var lines = [];
    Array.prototype.forEach.call(body.children, function (line) {
      var cmd = line.querySelector(".t-cmd");
      // A long command is wrapped across source lines in the HTML and carries
      // that indentation in its text — collapse it back onto one line.
      var text = (cmd || line).textContent.replace(/\s+/g, " ").trim();
      // A dimmed line is a shell comment when it reads as one, and printed
      // output otherwise ("2 results in 41ms"), which belongs to no paste.
      if (cmd || (line.classList.contains("t-dim") && text.charAt(0) === "#")) lines.push(text);
    });
    if (lines.length) return lines.join("\n");
    var pre = body.querySelector("pre");
    return pre ? pre.textContent.replace(/^\n/, "").replace(/\s+$/, "") : "";
  }

  document.querySelectorAll(".term").forEach(function (term) {
    // A terminal drawn as a figure (a diagram) is a picture, not a paste.
    if (term.closest && term.closest("figure")) return;
    var bar = term.querySelector(".term-bar");
    var text = payload(term);
    if (!bar || !text || bar.querySelector(".term-copy")) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "term-copy";
    btn.title = "Copy";
    btn.setAttribute("aria-label", "Copy to clipboard");
    btn.innerHTML = ICONS;

    var reset;
    btn.addEventListener("click", function () {
      navigator.clipboard
        .writeText(text)
        .then(function () {
          btn.classList.add("copied");
          btn.title = "Copied";
          btn.setAttribute("aria-label", "Copied to clipboard");
          clearTimeout(reset);
          reset = setTimeout(function () {
            btn.classList.remove("copied");
            btn.title = "Copy";
            btn.setAttribute("aria-label", "Copy to clipboard");
          }, 1600);
        })
        // An unfocused document or a denied permission rejects the write: leave
        // the button uncopied rather than throw an unhandled rejection.
        .catch(function () {});
    });
    bar.appendChild(btn);
  });
})();

/* Syntax colouring. A <pre data-lang="…"> is coloured as that language; a
   <pre> without one takes its language from the file its terminal card is
   titled with (".term-title", or a "# Caddyfile" line just above it), and an
   untitled <pre> that parses as JSON is coloured as JSON. Commands after a
   prompt (.t-cmd) get light shell colouring. Colouring only wraps runs of
   existing text in <span class="tok-…">: the text itself — and so what the
   copy button copies — never changes, and text already inside an authored
   element (a dimmed or highlighted span) keeps its own styling. */
(function () {
  if (
    !document.body ||
    !document.querySelectorAll ||
    !document.createElement ||
    !document.createTextNode ||
    !document.createDocumentFragment
  ) {
    return;
  }

  function words(list) {
    var set = Object.create(null);
    list.split(" ").forEach(function (word) {
      set[word] = true;
    });
    return set;
  }
  function isIdentStart(c) {
    return !!c && /[A-Za-z_$]/.test(c);
  }
  function isSpace(c) {
    return c === " " || c === "\t" || c === "\n" || c === "\r";
  }
  // Index just past a quoted string opening at `start`: backslash escapes the
  // next character, and an unterminated string ends at the line break.
  function endOfQuote(text, start, quote, multiline) {
    for (var i = start + 1; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === "\\") i++;
      else if (c === quote) return i + 1;
      else if (c === "\n" && !multiline) return i;
    }
    return text.length;
  }
  function nextNonSpace(text, i) {
    while (i < text.length && (text.charAt(i) === " " || text.charAt(i) === "\t")) i++;
    return text.charAt(i);
  }
  function prevNonSpace(text, i) {
    while (i >= 0 && isSpace(text.charAt(i))) i--;
    return text.charAt(i);
  }

  var NUMBER = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[nLuUfF]?/y;
  var OPERATOR = /=>|->|\?\?=?|\?\.|\.\.\.|\.\.<|[=!]==?|[<>]=?|&&=?|\|\|=?|[-+*/%&|^]=?|[!~?]/y;
  function match(re, text, i) {
    re.lastIndex = i;
    var m = re.exec(text);
    return m ? m[0] : null;
  }

  // TypeScript, JavaScript, Swift and Kotlin share one C-family lexer; the
  // languages differ in keywords and in how strings open.
  var C_FAMILY = {
    ts: {
      kw: words(
        "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof unique var void while with yield",
      ),
      constant: words("true false null undefined NaN Infinity"),
      builtin: words("string number boolean unknown any never object symbol bigint"),
      template: true,
    },
    swift: {
      kw: words(
        "actor any as associatedtype async await break case catch class continue convenience default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nonisolated open operator override private protocol public repeat required rethrows return self Self some static struct subscript super switch throw throws try typealias unowned var weak where while",
      ),
      constant: words("true false nil"),
      builtin: words(""),
      multiline: '"""',
      annotation: true,
    },
    kotlin: {
      kw: words(
        "abstract annotation as break by catch class companion const continue crossinline data do else enum external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend this throw try typealias val var vararg when where while",
      ),
      constant: words("true false null"),
      builtin: words(""),
      multiline: '"""',
      annotation: true,
    },
  };
  C_FAMILY.js = C_FAMILY.ts;

  function lexC(text, cfg, base, out) {
    var n = text.length;
    var i = 0;
    function push(start, end, type) {
      out.push([base + start, base + end, type]);
    }
    while (i < n) {
      var c = text.charAt(i);
      var d = text.charAt(i + 1);
      var end;
      var word;
      if (c === "/" && d === "/") {
        end = text.indexOf("\n", i);
        if (end < 0) end = n;
        push(i, end, "com");
        i = end;
      } else if (c === "/" && d === "*") {
        end = text.indexOf("*/", i + 2);
        end = end < 0 ? n : end + 2;
        push(i, end, "com");
        i = end;
      } else if (cfg.multiline && text.substr(i, 3) === cfg.multiline) {
        end = text.indexOf(cfg.multiline, i + 3);
        end = end < 0 ? n : end + 3;
        push(i, end, "str");
        i = end;
      } else if (c === '"' || c === "'") {
        end = endOfQuote(text, i, c, false);
        push(i, end, "str");
        i = end;
      } else if (c === "`" && cfg.template) {
        i = lexTemplate(text, i, cfg, base, out);
      } else if (c === "@" && cfg.annotation && isIdentStart(d)) {
        word = match(/@[\w.]+/y, text, i);
        push(i, i + word.length, "kw");
        i += word.length;
      } else if (/\d/.test(c) || (c === "." && /\d/.test(d))) {
        word = match(NUMBER, text, i) || c;
        // A digit run inside a name ("utf8") is part of that name.
        if (!isIdentStart(text.charAt(i + word.length))) push(i, i + word.length, "num");
        i += word.length;
      } else if (isIdentStart(c)) {
        word = match(/[A-Za-z_$][\w$]*/y, text, i);
        end = i + word.length;
        var after = nextNonSpace(text, end);
        var before = prevNonSpace(text, i - 1);
        var type = null;
        if (before === "." && text.charAt(i - 2) !== ".") type = after === "(" ? "fn" : "prop";
        else if (cfg.kw[word]) type = "kw";
        else if (cfg.constant[word]) type = "const";
        else if (cfg.builtin[word] || /^[A-Z]/.test(word)) type = "type";
        else if (after === "(") type = "fn";
        else if (after === ":" && text.charAt(text.indexOf(":", end) + 1) !== ":") type = "prop";
        if (type) push(i, end, type);
        i = end;
      } else {
        word = match(OPERATOR, text, i);
        if (word) {
          push(i, i + word.length, "op");
          i += word.length;
        } else {
          i++;
        }
      }
    }
    return out;
  }

  // A template literal is a string whose ${…} holes are code.
  function lexTemplate(text, start, cfg, base, out) {
    var n = text.length;
    var from = start;
    var i = start + 1;
    while (i < n) {
      var c = text.charAt(i);
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        out.push([base + from, base + i + 1, "str"]);
        return i + 1;
      } else if (c === "$" && text.charAt(i + 1) === "{") {
        if (i > from) out.push([base + from, base + i, "str"]);
        out.push([base + i, base + i + 2, "op"]);
        var depth = 1;
        var j = i + 2;
        while (j < n && depth) {
          var h = text.charAt(j);
          if (h === "{") depth++;
          else if (h === "}") depth--;
          else if (h === '"' || h === "'" || h === "`") {
            j = endOfQuote(text, j, h, h === "`") - 1;
          }
          j++;
        }
        var close = depth ? n : j - 1;
        lexC(text.slice(i + 2, close), cfg, base + i + 2, out);
        if (!depth) out.push([base + close, base + close + 1, "op"]);
        from = i = depth ? n : j;
      } else {
        i++;
      }
    }
    if (from < n) out.push([base + from, base + n, "str"]);
    return n;
  }

  function lexJson(text) {
    var out = [];
    var n = text.length;
    var i = 0;
    while (i < n) {
      var c = text.charAt(i);
      var end;
      var word;
      if (c === '"') {
        end = endOfQuote(text, i, c, false);
        out.push([i, end, nextNonSpace(text, end) === ":" ? "prop" : "str"]);
        i = end;
      } else if (c === "/" && text.charAt(i + 1) === "/") {
        end = text.indexOf("\n", i);
        if (end < 0) end = n;
        out.push([i, end, "com"]);
        i = end;
      } else if (/[-\d]/.test(c) && (word = match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, text, i))) {
        out.push([i, i + word.length, "num"]);
        i += word.length;
      } else if ((word = match(/true|false|null/y, text, i))) {
        out.push([i, i + word.length, "const"]);
        i += word.length;
      } else {
        i++;
      }
    }
    return out;
  }

  var SH_KEYWORDS = words(
    "if then else elif fi for while until do done case esac in function select return export local readonly unset",
  );
  // Words that run the command after them, which is then a command too.
  var SH_PREFIXES = words("sudo env nohup time exec command builtin xargs");

  // Shell. `inline` is a prompted command in running text: its command word
  // keeps the command colour so the prompt glyph stays the one accent.
  function lexShell(text, inline) {
    var out = [];
    var n = text.length;
    var i = 0;
    var commandNext = true;
    function variable(at) {
      var c = text.charAt(at + 1);
      var end;
      if (c === "{") {
        end = text.indexOf("}", at);
        end = end < 0 ? n : end + 1;
      } else if (/[A-Za-z_]/.test(c)) {
        end = at + match(/\$[A-Za-z_]\w*/y, text, at).length;
      } else if (/[\d?#@*!$-]/.test(c)) {
        end = at + 2;
      } else {
        return at;
      }
      out.push([at, end, "var"]);
      return end;
    }
    while (i < n) {
      var c = text.charAt(i);
      var end;
      var word;
      if (c === "\n") {
        // A line continued with a backslash is still the same command, and so
        // is a prompted command the page source wraps across lines.
        if (!inline && prevNonSpace(text, i - 1) !== "\\") commandNext = true;
        i++;
      } else if (isSpace(c)) {
        i++;
      } else if (c === "#" && (i === 0 || isSpace(text.charAt(i - 1)))) {
        end = text.indexOf("\n", i);
        if (end < 0) end = n;
        out.push([i, end, "com"]);
        i = end;
      } else if (c === "\\") {
        i += 2;
      } else if (c === "'") {
        end = endOfQuote(text, i, c, true);
        out.push([i, end, "str"]);
        i = end;
        commandNext = false;
      } else if (c === '"') {
        // Variables inside double quotes still expand, so they stay visible.
        end = endOfQuote(text, i, c, true);
        var from = i;
        for (var j = i + 1; j < end - 1; j++) {
          if (text.charAt(j) === "\\") {
            j++;
          } else if (text.charAt(j) === "$") {
            var after = variable(j);
            if (after > j) {
              if (j > from) out.splice(out.length - 1, 0, [from, j, "str"]);
              from = after;
              j = after - 1;
            }
          }
        }
        out.push([from, end, "str"]);
        out.sort(function (a, b) {
          return a[0] - b[0];
        });
        i = end;
        commandNext = false;
      } else if (c === "$") {
        if (text.charAt(i + 1) === "(") {
          out.push([i, i + 2, "op"]);
          i += 2;
          commandNext = true;
        } else {
          end = variable(i);
          i = end > i ? end : i + 1;
          commandNext = false;
        }
      } else if (c === "<" && (word = match(/<[A-Za-z][\w.:/-]*>/y, text, i))) {
        // A <placeholder> the reader replaces, not a redirection.
        out.push([i, i + word.length, "ph"]);
        i += word.length;
        commandNext = false;
      } else if ((word = match(/\|\||&&|[|&;()]|[0-9]?>>?|<</y, text, i))) {
        out.push([i, i + word.length, "op"]);
        i += word.length;
        commandNext = /[|&;(]/.test(word);
      } else {
        word = match(/[^\s;|&<>()'"`$\\]+/y, text, i) || c;
        end = i + word.length;
        var assign = match(/[A-Za-z_]\w*=/y, text, i);
        if (commandNext && assign) {
          out.push([i, i + assign.length - 1, "prop"]);
          out.push([i + assign.length - 1, i + assign.length, "op"]);
          if (end > i + assign.length) out.push([i + assign.length, end, "str"]);
        } else if (commandNext && SH_KEYWORDS[word]) {
          out.push([i, end, "kw"]);
          // "for NAME in …", "case WORD in": a name follows, not a command.
          commandNext = !/^(for|select|case|function|unset|local|readonly)$/.test(word);
        } else if (commandNext) {
          if (!inline) out.push([i, end, "fn"]);
          commandNext = !!SH_PREFIXES[word];
        } else if (/^--?[A-Za-z]/.test(word)) {
          var eq = word.indexOf("=");
          out.push([i, eq > 0 ? i + eq : end, "flag"]);
        } else if (/^\d+(\.\d+)?$/.test(word)) {
          out.push([i, end, "num"]);
        }
        i = end;
      }
    }
    return out;
  }

  // A scalar after a key: quoted strings, numbers, booleans, a trailing
  // comment, and (for YAML and .env) a bare word that is a string.
  function lexValue(text, base, out, style) {
    var n = text.length;
    var i = 0;
    while (i < n) {
      var c = text.charAt(i);
      var word;
      var end;
      if (isSpace(c) || /[[\]{},]/.test(c)) {
        i++;
      } else if (
        (c === "#" || (style.semicolon && c === ";")) &&
        (i === 0 || isSpace(text.charAt(i - 1)))
      ) {
        out.push([base + i, base + n, "com"]);
        return;
      } else if (c === '"' || c === "'") {
        end = endOfQuote(text, i, c, false);
        out.push([base + i, base + end, "str"]);
        i = end;
      } else {
        word = match(/[^\s,[\]{}#]+(?:[ \t]+[^\s,[\]{}#]+)*/y, text, i) || c;
        end = i + word.length;
        var type = style.bare;
        if (/^[-+]?(\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|0x[\da-fA-F]+)$/.test(word)) type = "num";
        else if (style.constants.test(word)) type = "const";
        else if (/^[&*][\w-]+$/.test(word)) type = "type";
        else if (/^[|>][+-]?$/.test(word)) type = "op";
        if (type) out.push([base + i, base + end, type]);
        i = end;
      }
    }
  }

  function lexLines(text, line) {
    var out = [];
    var offset = 0;
    text.split("\n").forEach(function (content) {
      line(content, offset, out);
      offset += content.length + 1;
    });
    return out;
  }

  var YAML_STYLE = { bare: "str", constants: /^(true|false|yes|no|on|off|null|~)$/i };
  function lexYaml(text) {
    return lexLines(text, function (content, base, out) {
      var m = /^([ \t]*)(#.*)$/.exec(content);
      if (m) {
        out.push([base + m[1].length, base + content.length, "com"]);
        return;
      }
      m = /^([ \t]*(?:- +)*)("[^"]*"|'[^']*'|[^\s#:'"-][^#:]*?|-[^\s#:][^#:]*?)(:)(?=\s|$)/.exec(
        content,
      );
      var rest = 0;
      if (m) {
        out.push([base + m[1].length, base + m[1].length + m[2].length, "prop"]);
        rest = m[0].length;
      } else {
        m = /^[ \t]*(?:- +)+/.exec(content);
        if (m) rest = m[0].length;
      }
      if (content.charAt(rest) === "-" && rest === 0 && /^(---|\.\.\.)\s*$/.test(content)) {
        out.push([base, base + content.length, "op"]);
        return;
      }
      lexValue(content.slice(rest), base + rest, out, YAML_STYLE);
    });
  }

  function iniLexer(style) {
    return function (text) {
      return lexLines(text, function (content, base, out) {
        var m = style.comment.exec(content);
        if (m) {
          out.push([base + m[1].length, base + content.length, "com"]);
          return;
        }
        m = /^([ \t]*)(\[\[?[^\]]*\]\]?)/.exec(content);
        if (m) {
          out.push([base + m[1].length, base + m[0].length, "type"]);
          return;
        }
        m = /^([ \t]*)(export[ \t]+)?([^=\s#;][^=]*?)([ \t]*[=:][ \t]*)/.exec(content);
        if (!m) return;
        var at = base + m[1].length;
        if (m[2]) {
          out.push([at, at + 6, "kw"]);
          at += m[2].length;
        }
        out.push([at, at + m[3].length, "prop"]);
        lexValue(content.slice(m[0].length), base + m[0].length, out, style);
      });
    };
  }

  // Caddyfile: a site address opens a top-level block; the first word of any
  // other line is a directive.
  function lexCaddy(text) {
    var depth = 0;
    return lexLines(text, function (content, base, out) {
      var first = true;
      var i = 0;
      var n = content.length;
      while (i < n) {
        var c = content.charAt(i);
        var word;
        var end;
        if (isSpace(c)) {
          i++;
          continue;
        }
        if (c === "#" && (i === 0 || isSpace(content.charAt(i - 1)))) {
          out.push([base + i, base + n, "com"]);
          return;
        }
        if (c === "{" || c === "}") {
          if (
            c === "{" &&
            /\S/.test(content.charAt(i + 1)) &&
            (end = content.indexOf("}", i)) > i
          ) {
            out.push([base + i, base + end + 1, "var"]);
            i = end + 1;
            first = false;
            continue;
          }
          depth += c === "{" ? 1 : -1;
          i++;
          continue;
        }
        if (c === '"' || c === "`") {
          end = endOfQuote(content, i, c, false);
          out.push([base + i, base + end, "str"]);
          i = end;
          first = false;
          continue;
        }
        word = match(/[^\s{}"`]+/y, content, i);
        end = i + word.length;
        var type = null;
        if (first) type = depth === 0 ? "type" : "fn";
        else if (word.charAt(0) === "@") type = "const";
        else if (/^\d+(\.\d+)?(ms|s|m|h|d)?$/.test(word)) type = "num";
        if (type) out.push([base + i, base + end, type]);
        first = false;
        i = end;
      }
    });
  }

  function lexMarkdown(text) {
    var fenced = false;
    return lexLines(text, function (content, base, out) {
      if (/^\s*(```|~~~)/.test(content)) {
        fenced = !fenced;
        out.push([base, base + content.length, "str"]);
        return;
      }
      if (fenced) {
        out.push([base, base + content.length, "str"]);
        return;
      }
      var m = /^#{1,6}\s.*$/.exec(content);
      if (m) {
        out.push([base, base + content.length, "kw"]);
        return;
      }
      m = /^(\s*)([-*+]|\d+[.)])(?=\s)/.exec(content);
      if (m) out.push([base + m[1].length, base + m[0].length, "op"]);
      var code = /`[^`]+`/g;
      while ((m = code.exec(content))) out.push([base + m.index, base + code.lastIndex, "str"]);
    });
  }

  var LEXERS = {
    ts: function (t) {
      return lexC(t, C_FAMILY.ts, 0, []);
    },
    js: function (t) {
      return lexC(t, C_FAMILY.js, 0, []);
    },
    swift: function (t) {
      return lexC(t, C_FAMILY.swift, 0, []);
    },
    kotlin: function (t) {
      return lexC(t, C_FAMILY.kotlin, 0, []);
    },
    json: lexJson,
    sh: function (t) {
      return lexShell(t, false);
    },
    yaml: lexYaml,
    ini: iniLexer({
      comment: /^([ \t]*)[#;].*$/,
      semicolon: true,
      bare: "str",
      constants: /^(true|false|yes|no|on|off)$/i,
    }),
    toml: iniLexer({
      comment: /^([ \t]*)#.*$/,
      semicolon: false,
      bare: null,
      constants: /^(true|false|inf|nan)$/,
    }),
    caddy: lexCaddy,
    md: lexMarkdown,
  };
  var ALIASES = {
    typescript: "ts",
    tsx: "ts",
    javascript: "js",
    jsx: "js",
    mjs: "js",
    jsonc: "json",
    bash: "sh",
    shell: "sh",
    zsh: "sh",
    yml: "yaml",
    env: "ini",
    dotenv: "ini",
    conf: "ini",
    systemd: "ini",
    caddyfile: "caddy",
    kt: "kotlin",
    kts: "kotlin",
    markdown: "md",
  };
  function language(name) {
    name = String(name || "").toLowerCase();
    name = ALIASES[name] || name;
    return LEXERS[name] ? name : null;
  }

  // The language a file name implies: its extension, or a well-known name.
  function languageOfFile(name) {
    name = String(name || "")
      .trim()
      .replace(/^#\s*/, "");
    if (!name || /\s/.test(name) || /\/$/.test(name)) return null;
    var base = name.split("/").pop();
    if (/^caddyfile$/i.test(base)) return "caddy";
    if (/^\.env(\..+)?$/.test(base) || /\.env$/.test(base)) return "ini";
    if (/^\.(bash|zsh)rc$|^\.profile$/.test(base)) return "sh";
    var ext = /\.([A-Za-z0-9]+)$/.exec(base);
    if (!ext) return null;
    var map = {
      ts: "ts",
      mts: "ts",
      cts: "ts",
      tsx: "ts",
      js: "js",
      mjs: "js",
      cjs: "js",
      jsx: "js",
      json: "json",
      jsonc: "json",
      yaml: "yaml",
      yml: "yaml",
      sh: "sh",
      bash: "sh",
      zsh: "sh",
      toml: "toml",
      ini: "ini",
      cfg: "ini",
      conf: "ini",
      service: "ini",
      swift: "swift",
      kt: "kotlin",
      kts: "kotlin",
      md: "md",
    };
    return map[ext[1].toLowerCase()] || null;
  }

  function textOf(el) {
    return (el && el.textContent) || "";
  }

  function inferLanguage(pre) {
    var term = pre.closest ? pre.closest(".term") : null;
    var title = term && term.querySelector(".term-title");
    if (title) return languageOfFile(textOf(title));
    // A card whose file is named in a "# Caddyfile" line just above the <pre>.
    var prev = pre.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains("t-dim")) {
      var named = /^\s*#\s*(\S+)\s*$/.exec(textOf(prev));
      if (named) {
        var lang = languageOfFile(named[1]);
        if (lang) return lang;
      }
    }
    // Printed output never parses as JSON; a JSON file always does.
    var body = textOf(pre).trim();
    if (/^[[{]/.test(body) && pre.children && pre.children.length === 0) {
      try {
        JSON.parse(body);
        return "json";
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // Wraps each token's text in a span. Tokens are character ranges over the
  // element's textContent; only text that sits directly in the element is
  // wrapped, and a token that crosses into an authored child is cut there.
  function paint(el, tokens) {
    tokens.sort(function (a, b) {
      return a[0] - b[0];
    });
    var clean = [];
    var last = 0;
    tokens.forEach(function (token) {
      if (token[1] > token[0] && token[0] >= last) {
        clean.push(token);
        last = token[1];
      }
    });
    if (!clean.length) return;
    var pieces = [];
    var offset = 0;
    Array.prototype.forEach.call(el.childNodes, function (node) {
      var length = textOf(node).length;
      if (node.nodeType === 3) pieces.push([node, offset]);
      offset += length;
    });
    var k = 0;
    pieces.forEach(function (piece) {
      var node = piece[0];
      var start = piece[1];
      var value = node.nodeValue;
      var end = start + value.length;
      while (k < clean.length && clean[k][1] <= start) k++;
      if (k >= clean.length || clean[k][0] >= end) return;
      var fragment = document.createDocumentFragment();
      var pos = start;
      while (k < clean.length && clean[k][0] < end) {
        var from = Math.max(clean[k][0], start);
        var to = Math.min(clean[k][1], end);
        if (from > pos)
          fragment.appendChild(document.createTextNode(value.slice(pos - start, from - start)));
        var span = document.createElement("span");
        span.className = "tok-" + clean[k][2];
        span.textContent = value.slice(from - start, to - start);
        fragment.appendChild(span);
        pos = to;
        if (clean[k][1] > end) break;
        k++;
      }
      if (pos < end) fragment.appendChild(document.createTextNode(value.slice(pos - start)));
      node.parentNode.replaceChild(fragment, node);
    });
  }

  function highlight(el, lang, lex) {
    if (el.hasAttribute("data-highlighted")) return;
    el.setAttribute("data-highlighted", lang);
    try {
      paint(el, lex(textOf(el)));
    } catch (e) {
      /* An unexpected shape stays plain text rather than breaking the page. */
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll("pre"), function (pre) {
    if (!pre.getAttribute || !pre.hasAttribute) return;
    var lang = pre.hasAttribute("data-lang")
      ? language(pre.getAttribute("data-lang"))
      : inferLanguage(pre);
    if (lang) highlight(pre, lang, LEXERS[lang]);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".term-body .t-cmd"), function (cmd) {
    if (!cmd.getAttribute || !cmd.hasAttribute) return;
    highlight(cmd, "sh", function (text) {
      return lexShell(text, true);
    });
  });
})();

/* Reading aids for the docs pages, all progressive: the static HTML reads the
   same without them.
   - A "#" self-link on every h2/h3 that has an id.
   - An "On this page" disclosure under the lead, built from the sidebar's
     section list; the stylesheet shows it only where the sidebar collapses
     into the page strip.
   - The page strip scrolls the current page's pill into view.
   - Reference tables get each column's header copied into data-label, so the
     stylesheet can stack them into labelled cards on a phone.
   - Terminal bodies and tables that scroll sideways become focusable, named
     regions (so a keyboard can scroll them), and terminals and the strip fade
     at the edge that hides content. */
(function () {
  if (!document.body || !document.querySelector || !document.createElement) return;
  var content = document.querySelector(".docs-content");
  if (!content || !content.querySelectorAll) return;
  var each = function (list, fn) {
    Array.prototype.forEach.call(list || [], fn);
  };
  var text = function (el) {
    return ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  };

  each(content.querySelectorAll("h2[id], h3[id]"), function (heading) {
    if (heading.querySelector(".h-anchor")) return;
    // A heading inside a link (a linked card) cannot hold another link.
    if (heading.closest && heading.closest("a")) return;
    var link = document.createElement("a");
    link.className = "h-anchor";
    link.href = "#" + heading.id;
    link.setAttribute("aria-label", "Link to section: " + text(heading));
    link.textContent = "#";
    heading.appendChild(link);
  });

  var sections = document.querySelector(".docs-sidebar .side-sub");
  var h1 = content.querySelector("h1");
  var sectionLinks = sections && sections.querySelectorAll ? sections.querySelectorAll("a") : [];
  if (
    h1 &&
    h1.insertAdjacentElement &&
    sectionLinks.length &&
    !content.querySelector(".toc-mobile")
  ) {
    var toc = document.createElement("details");
    toc.className = "toc-mobile";
    var summary = document.createElement("summary");
    summary.textContent = "On this page";
    toc.appendChild(summary);
    var list = document.createElement("ul");
    each(sectionLinks, function (source) {
      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = source.getAttribute("href");
      link.textContent = text(source);
      item.appendChild(link);
      list.appendChild(item);
    });
    toc.appendChild(list);
    list.addEventListener("click", function (event) {
      if (event.target && event.target.closest && event.target.closest("a")) toc.open = false;
    });
    var lead = h1.nextElementSibling;
    var after = lead && lead.classList && lead.classList.contains("docs-lead") ? lead : h1;
    after.insertAdjacentElement("afterend", toc);
  }

  // A table authored without its scrolling wrapper gets one, so it can never
  // widen the page.
  each(content.querySelectorAll("table"), function (table) {
    var parent = table.parentElement;
    if (!parent || (parent.classList && parent.classList.contains("table-wrap"))) return;
    var wrapper = document.createElement("div");
    wrapper.className = "table-wrap";
    parent.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });

  each(content.querySelectorAll(".table-wrap"), function (wrap) {
    var table = wrap.querySelector("table");
    var head = table && table.tHead && table.tHead.rows[0];
    if (!head) return;
    var labels = [];
    each(head.cells, function (cell) {
      for (var i = 0; i < (cell.colSpan || 1); i++) labels.push(text(cell));
    });
    each(table.tBodies, function (body) {
      each(body.rows, function (row) {
        var column = 0;
        each(row.cells, function (cell) {
          if (labels[column] && !cell.hasAttribute("data-label")) {
            cell.setAttribute("data-label", labels[column]);
          }
          column += cell.colSpan || 1;
        });
      });
    });
    wrap.classList.add("stack");
  });

  // The heading a region sits under, for its accessible name.
  function sectionOf(el) {
    for (var node = el; node && node !== content; node = node.parentElement) {
      for (var prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (/^H[1-3]$/.test(prev.tagName)) return text(prev).replace(/\s*#$/, "");
      }
    }
    return "";
  }

  function fade(el) {
    var max = el.scrollWidth - el.clientWidth;
    var start = el.scrollLeft > 1;
    var end = el.scrollLeft < max - 1;
    if (max <= 1 || (!start && !end)) el.removeAttribute("data-fade");
    else el.setAttribute("data-fade", start && end ? "both" : start ? "start" : "end");
  }

  var regions = [];
  each(content.querySelectorAll(".term-body, .table-wrap"), function (el) {
    var term = el.classList.contains("term-body") && el.parentElement;
    var title = term && term.querySelector(".term-title");
    var kind = term ? "Terminal" : "Table";
    var where = text(title) || sectionOf(el);
    regions.push({
      el: el,
      label: where ? kind + ": " + where : kind,
      fades: !!term,
    });
    if (term) {
      el.addEventListener(
        "scroll",
        function () {
          fade(el);
        },
        { passive: true },
      );
    }
  });

  var strip = document.querySelector(".docs-sidebar nav");
  var current = strip && strip.querySelector && strip.querySelector('a[aria-current="page"]');
  if (strip && strip.addEventListener) {
    strip.addEventListener(
      "scroll",
      function () {
        fade(strip);
      },
      { passive: true },
    );
  }

  function layout() {
    regions.forEach(function (region) {
      var el = region.el;
      var scrolls = el.scrollWidth > el.clientWidth + 1;
      if (scrolls && !el.hasAttribute("tabindex")) {
        el.setAttribute("tabindex", "0");
        el.setAttribute("role", "region");
        el.setAttribute("aria-label", region.label);
        el.setAttribute("data-scroll-region", "");
      } else if (!scrolls && el.hasAttribute("data-scroll-region")) {
        el.removeAttribute("tabindex");
        el.removeAttribute("role");
        el.removeAttribute("aria-label");
        el.removeAttribute("data-scroll-region");
      }
      if (region.fades) fade(el);
    });
    if (strip && strip.getBoundingClientRect) fade(strip);
  }

  function centreCurrentPage() {
    if (!current || !current.getBoundingClientRect) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    var pill = current.getBoundingClientRect();
    var box = strip.getBoundingClientRect();
    strip.scrollLeft += pill.left + pill.width / 2 - (box.left + box.width / 2);
  }

  if (typeof window.addEventListener === "function") {
    var pending = null;
    window.addEventListener("resize", function () {
      clearTimeout(pending);
      pending = setTimeout(layout, 120);
    });
    // Fonts change widths once they load; measure after they settle.
    window.addEventListener("load", function () {
      centreCurrentPage();
      layout();
    });
  }
  centreCurrentPage();
  layout();
  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(function () {
      centreCurrentPage();
      layout();
    });
  }
})();

// Landing on a #section: the browser jumps there before the web fonts load,
// and their reflow can move the heading away again. Until the reader scrolls
// themselves, the heading is re-aligned once fonts and the page have loaded;
// only then does in-page navigation become smooth.
(function () {
  var root = document.documentElement;
  if (!root || !root.classList || typeof window.addEventListener !== "function") return;
  var readerMoved = false;
  var markMoved = function () {
    readerMoved = true;
  };
  ["wheel", "touchstart", "keydown", "mousedown"].forEach(function (type) {
    window.addEventListener(type, markMoved, { passive: true, once: true });
  });
  function realign() {
    if (readerMoved || !window.location.hash) return;
    var id;
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch (e) {
      return;
    }
    var target = document.getElementById(id);
    if (target && target.scrollIntoView) target.scrollIntoView({ block: "start" });
  }
  if (typeof Promise !== "function") {
    root.classList.add("smooth-scroll");
    return;
  }
  var fontsReady =
    document.fonts && document.fonts.ready && document.fonts.ready.then
      ? document.fonts.ready
      : Promise.resolve();
  var loaded = new Promise(function (resolve) {
    if (document.readyState === "complete") resolve();
    else window.addEventListener("load", resolve, { once: true });
  });
  Promise.all([fontsReady, loaded]).then(function () {
    realign();
    // One more frame so a late layout pass (the page strip, the table labels)
    // is included before smooth scrolling takes over.
    var nextFrame =
      window.requestAnimationFrame ||
      function (callback) {
        setTimeout(callback, 16);
      };
    nextFrame(function () {
      realign();
      root.classList.add("smooth-scroll");
    });
  });
})();
