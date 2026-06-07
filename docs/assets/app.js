/* ============================================================================
   tachi-agent docs — shared behavior (vanilla JS, no deps)
   - mobile nav toggle
   - active nav highlighting
   - copy-to-clipboard on every code block
   - hero terminal typewriter
   - IntersectionObserver scroll reveals
   All motion respects prefers-reduced-motion.
   ============================================================================ */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- mobile nav toggle ---------- */
  function initNav() {
    var toggle = document.querySelector(".nav-toggle");
    var links = document.querySelector(".nav-links");
    if (!toggle || !links) return;
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "✕" : "≡";
    });
    // close menu when a link is chosen
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "≡";
      }
    });
  }

  /* ---------- active nav (match by filename) ---------- */
  function initActiveNav() {
    var path = location.pathname.split("/").pop() || "index.html";
    if (path === "") path = "index.html";
    var anchors = document.querySelectorAll(".nav-links a");
    anchors.forEach(function (a) {
      var href = (a.getAttribute("href") || "").split("/").pop();
      if (href === path) {
        a.classList.add("active");
        a.setAttribute("aria-current", "page");
      }
    });
  }

  /* ---------- copy buttons ---------- */
  function initCopy() {
    var blocks = document.querySelectorAll(".code");
    blocks.forEach(function (block) {
      var btn = block.querySelector(".copy-btn");
      var pre = block.querySelector("pre");
      if (!btn || !pre) return;
      btn.addEventListener("click", function () {
        var text = pre.innerText;
        var done = function () {
          var prev = btn.textContent;
          btn.textContent = "copied ✓";
          btn.classList.add("copied");
          setTimeout(function () {
            btn.textContent = prev;
            btn.classList.remove("copied");
          }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, fallback);
        } else {
          fallback();
        }
        function fallback() {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (e) { /* noop */ }
          document.body.removeChild(ta);
        }
      });
    });
  }

  /* ---------- scroll reveals ---------- */
  function initReveals() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    if (reduceMotion || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---------- hero terminal typewriter ---------- */
  function initTerminal() {
    var term = document.querySelector("[data-terminal]");
    if (!term) return;

    // Script: each entry is {text, cls, delayAfter?, instant?}
    var script = [
      { t: "$ ", cls: "prompt", instant: true },
      { t: 'tachi-agent "verify HEAD against ADR-1..3"', cls: "cmd" },
      { t: "\n", instant: true, pause: 380 },
      { t: "— step 1 —\n", cls: "step", instant: true, pause: 220 },
      { t: "🔧 tachibot_jury, dokoro_session_recall\n", cls: "tool", instant: true, pause: 260 },
      { t: "— step 2 —\n", cls: "step", instant: true, pause: 220 },
      { t: "🔧 tachibot_council\n", cls: "tool", instant: true, pause: 260 },
      { t: "✅ halted: final-answer\n\n", cls: "ok", instant: true, pause: 320 },
      { t: "HEAD upholds ADR-1 and ADR-3; ADR-2 (cooperative\nabort) is partially met — Ctrl-C halts, exit code\npending. Council quorum 3/3.", cls: "ans" }
    ];

    var out = term;
    out.textContent = "";

    if (reduceMotion) {
      script.forEach(function (s) { append(s.t, s.cls); });
      return;
    }

    // blinking cursor element
    var cursor = document.createElement("span");
    cursor.className = "cursor";
    cursor.textContent = "▍";
    out.appendChild(cursor);

    function append(text, cls) {
      var span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = text;
      out.insertBefore(span, cursor);
    }

    var i = 0;
    function runEntry() {
      if (i >= script.length) {
        return; // keep blinking cursor at end
      }
      var entry = script[i++];
      if (entry.instant) {
        append(entry.t, entry.cls);
        setTimeout(runEntry, entry.pause || 40);
      } else {
        typeText(entry.t, entry.cls, function () {
          setTimeout(runEntry, entry.pause || 120);
        });
      }
    }

    function typeText(text, cls, done) {
      var span = document.createElement("span");
      if (cls) span.className = cls;
      out.insertBefore(span, cursor);
      var j = 0;
      (function step() {
        if (j < text.length) {
          span.textContent += text.charAt(j++);
          setTimeout(step, 26 + Math.random() * 34);
        } else {
          done();
        }
      })();
    }

    // small initial delay so it begins after the hero reveals
    setTimeout(runEntry, 900);
  }

  /* ---------- boot ---------- */
  function boot() {
    initNav();
    initActiveNav();
    initCopy();
    initReveals();
    initTerminal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
