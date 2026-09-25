// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The "getting ready for open source" notice, shared by every page whose nav
 * or footer carries a GitHub link.
 *
 * It lives in a script rather than in each page's markup because the site is
 * static HTML served straight from disk — there is no include to share a
 * partial with, so anything two pages both show is otherwise two copies that
 * drift. Injecting it is safe for this particular block and not for others:
 * nothing reads it until someone clicks, so a reader with JavaScript off and
 * a crawler that never runs it lose nothing they would have had.
 *
 * A page opts in by carrying one or more `data-oss-open` elements and loading
 * this file with `defer`, so they are in the DOM by the time it runs.
 */

const STYLE = `
.oss-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 20px;
}
.oss-modal[hidden] {
  display: none;
}
.oss-modal__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(1, 4, 9, 0.72);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  animation: ossFade 0.2s ease;
}
.oss-modal__card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 430px;
  background: var(--bg-card, #131921);
  border: 1px solid var(--border, #30363d);
  border-radius: 18px;
  padding: 30px 28px 26px;
  text-align: center;
  box-shadow: 0 30px 80px -30px rgba(0, 0, 0, 0.85);
  animation: ossPop 0.26s cubic-bezier(0.2, 0.9, 0.3, 1.1);
}
.oss-modal__close {
  position: absolute;
  top: 10px;
  right: 14px;
  background: none;
  border: none;
  color: var(--text-muted, #6e7681);
  font-size: 26px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  transition: color 0.15s;
}
.oss-modal__close:hover {
  color: var(--text-primary, #e6edf3);
}
.oss-modal__title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text-primary, #e6edf3);
  margin: 0 0 10px;
}
.oss-modal__body {
  font-size: 15px;
  line-height: 1.55;
  color: var(--text-secondary, #8b949e);
  margin: 0 0 22px;
}
.oss-modal__form {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.oss-modal__input {
  flex: 1 1 180px;
  min-width: 0;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border, #30363d);
  background: var(--bg-primary, #0d1117);
  color: var(--text-primary, #e6edf3);
  font: inherit;
  font-size: 15px;
}
.oss-modal__input:focus {
  outline: none;
  border-color: var(--accent, #58a6ff);
  box-shadow: 0 0 0 3px var(--accent-glow, rgba(88, 166, 255, 0.15));
}
.oss-modal__btn {
  flex: 0 0 auto;
  padding: 12px 20px;
  border-radius: 10px;
  border: none;
  background: var(--accent, #58a6ff);
  color: #fff;
  font: inherit;
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
  transition:
    background 0.15s,
    transform 0.12s;
}
.oss-modal__btn:hover {
  background: var(--accent-hover, #79c0ff);
}
.oss-modal__btn:active {
  transform: scale(0.98);
}
.oss-modal__note {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--text-muted, #6e7681);
}
.oss-modal__ok {
  display: none;
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-primary, #e6edf3);
  background: rgba(63, 185, 80, 0.1);
  border: 1px solid rgba(63, 185, 80, 0.3);
}
@keyframes ossFade {
  from {
    opacity: 0;
  }
}
@keyframes ossPop {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.97);
  }
}
`;

const MARKUP = `
<div
      id="oss-modal"
      class="oss-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="oss-modal-title"
      hidden
    >
      <div class="oss-modal__backdrop" data-oss-close></div>
      <div class="oss-modal__card">
        <button class="oss-modal__close" type="button" aria-label="Close" data-oss-close>
          &times;
        </button>
        <h2 id="oss-modal-title" class="oss-modal__title">Getting ready for open source</h2>
        <p class="oss-modal__body">
          We're putting the finishing touches on Omnesis. Leave your email and we'll tell you the
          moment the repo goes public &mdash; plus major releases and new sources.
        </p>
        <form
          class="oss-modal__form"
          id="oss-form"
          action="https://app.kit.com/forms/9517046/subscriptions"
          method="post"
        >
          <input
            class="oss-modal__input"
            type="email"
            name="email_address"
            placeholder="you@example.com"
            required
            aria-label="Email address"
          />
          <button class="oss-modal__btn" type="submit">Notify me</button>
        </form>
        <p class="oss-modal__note">A few emails a year, no spam.</p>
        <div class="oss-modal__ok" id="oss-ok">
          &#10003; You're on the list &mdash; we'll email you the moment Omnesis is public.
        </div>
      </div>
    </div>
`;

(function () {
  const openers = document.querySelectorAll("[data-oss-open]");
  if (openers.length === 0) return;

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const host = document.createElement("div");
  host.innerHTML = MARKUP;
  const modal = host.firstElementChild;
  document.body.appendChild(modal);

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
  // Kit (ConvertKit) subscribe — fetch, fire-and-forget (Kit sends no CORS headers),
  // fall back to a native submit if the request rejects. Same approach as the page's other forms.
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
