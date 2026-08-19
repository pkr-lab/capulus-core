// xibosignage Slideshow — liest periodisch manifest.json (vom
// xibosignage-manifest.timer generiert) und zeigt die enthaltenen Bilder als
// Crossfade-Slideshow. Kein echter Xibo-Player: reine, robuste
// Ordner-zu-Bildschirm-Anzeige, siehe docs/3-apps-workloads/300e0-xibosignage.md.
(function () {
  "use strict";

  var slideA = document.getElementById("slideA");
  var slideB = document.getElementById("slideB");
  var placeholder = document.getElementById("placeholder");

  var manifest = [];
  var currentIndex = 0;
  var activeSlide = slideA;
  var otherSlide = slideB;

  function loadManifest() {
    fetch("manifest.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        return res.ok ? res.json() : [];
      })
      .then(function (data) {
        manifest = Array.isArray(data) ? data : [];
      })
      .catch(function () {
        // Manifest kurz nicht lesbar (Timer läuft gerade) — nächster
        // Versuch kommt automatisch, aktuelle Slideshow läuft unbeeinflusst weiter.
      });
  }

  function showNext() {
    if (manifest.length === 0) {
      placeholder.classList.remove("hidden");
      slideA.classList.remove("visible");
      slideB.classList.remove("visible");
      return;
    }

    placeholder.classList.add("hidden");

    var url = manifest[currentIndex % manifest.length] + "?t=" + Date.now();
    currentIndex += 1;

    var preload = new Image();
    preload.onload = function () {
      otherSlide.src = url;
      otherSlide.classList.add("visible");
      activeSlide.classList.remove("visible");

      var tmp = activeSlide;
      activeSlide = otherSlide;
      otherSlide = tmp;
    };
    preload.onerror = function () {
      // Datei zwischen Manifest-Scan und Anzeige verschwunden/kaputt —
      // einfach überspringen, der nächste Timer-Tick zeigt das nächste Bild.
    };
    preload.src = url;
  }

  loadManifest();
  setInterval(loadManifest, REFRESH_MANIFEST_MS);
  setInterval(showNext, SLIDE_DURATION_MS);
})();
