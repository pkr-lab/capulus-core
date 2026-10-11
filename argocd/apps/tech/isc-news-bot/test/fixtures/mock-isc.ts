import http from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_USER = "testuser";
export const MOCK_PASS = "testpass-platzhalter";
export const MOCK_EDV = "1002011";
export const OTHER_EDV = "2000002";
export const MOCK_CATEGORIES = [
  { value: "13", name: "DSM 2017" },
  { value: "4", name: "DLRG Andernach" },
  { value: "5", name: "Einsatzgruppe" },
  { value: "6", name: "Schwimmtraining" },
  { value: "3", name: "Lehrgänge/Kurse" },
  { value: "7", name: "DLRG Jugend" },
  { value: "14", name: "Wasserrettungsdienst" },
  { value: "15", name: "Wachstation frei" },
  { value: "16", name: "Wachstation belegt" },
  { value: "21876", name: "Material" },
  { value: "22926", name: "Warteliste" },
  { value: "22607", name: "EDV" },
];

const GLIEDERUNG_NAMES: Record<string, string> = {
  [MOCK_EDV]: "Ortsgruppe Andernach e.V.",
  [OTHER_EDV]: "Zweite Gliederung",
};

export type MockAsset = { id: string; name: string; keywords: string };

export type MockNews = {
  id: number;
  db: string;
  title: string;
  subtitle: string;
  html: string;
  type: string;
  categories: string[];
  status: "gesperrt" | "veroeffentlicht";
  disallowResize: boolean;
  firstAssetOnlyTeaser: boolean;
  assets: MockAsset[];
};

export type MockOptions = {
  initialEdv?: string;
  failSwitch?: boolean;
  failLogin?: boolean;
  saveUnconfirmedFor?: string;
  failUploadFor?: string;
  noEditor?: boolean;
  socialText?: string;
  formError?: string;
  startNewsId?: number;
};

export type MockIsc = {
  baseUrl: string;
  news: MockNews[];
  requests: string[];
  close: () => Promise<void>;
};

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) result[key] = rest.join("=");
  }
  return result;
}

const SCRIPT = `
window.jQuery = function (sel) {
  var els = typeof sel === 'string' ? Array.prototype.slice.call(document.querySelectorAll(sel)) : [sel];
  var api = {
    length: els.length,
    selectpicker: function (cmd, val) {
      if (cmd === 'val') {
        els.forEach(function (el) {
          Array.prototype.forEach.call(el.options, function (o) { o.selected = val.indexOf(o.value) !== -1; });
        });
      }
      return api;
    },
    val: function () {
      var el = els[0];
      if (!el) return undefined;
      if (el.multiple) return Array.prototype.filter.call(el.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
      return el.value;
    },
    trigger: function (ev) {
      els.forEach(function (el) { el.dispatchEvent(new Event(ev, { bubbles: true })); });
      return api;
    },
    parsley: function () { return { validate: validateParsley }; }
  };
  return api;
};
window.jQuery.fn = { parsley: function () {} };
function validateParsley() {
  var list = document.querySelector('.parsley-errors-list');
  list.innerHTML = '';
  var author = document.getElementById('AUTHOR').value;
  if (author.indexOf('FORMFEHLER') !== -1) {
    list.innerHTML = '<ul><li>Autor enthält ungültige Zeichen</li></ul>';
    return false;
  }
  return true;
}
function typSelect() {
  var v = document.getElementById('TYP').value;
  ['nt0', 'nt1', 'nt2'].forEach(function (id, i) {
    document.getElementById(id).style.display = String(i) === v ? 'block' : 'none';
  });
}
document.getElementById('TYP').addEventListener('change', typSelect);
typSelect();
function showTab(id) {
  document.querySelectorAll('.tab-pane').forEach(function (p) { p.style.display = p.id === id ? 'block' : 'none'; });
}
document.querySelectorAll('a[href^="#tab-"]').forEach(function (a) {
  a.addEventListener('click', function (e) { e.preventDefault(); showTab(a.getAttribute('href').slice(1)); });
});
document.getElementById('uploadRibbonButton').addEventListener('click', function () {
  document.getElementById('uploadRibbon').style.display = 'block';
});
(function () {
  var hidden = document.getElementById('mainUploadUploadKeywordTk');
  var typed = document.querySelector('#mainUpload input.token-input-input-token');
  var list = typed.parentElement.parentElement;
  function refresh() {
    hidden.value = Array.prototype.map.call(document.querySelectorAll('#mainUpload li.token-input-token'), function (li) {
      return li.getAttribute('data-value');
    }).join(',');
  }
  typed.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var value = typed.value.trim();
    if (!value) return;
    var li = document.createElement('li');
    li.className = 'token-input-token';
    li.setAttribute('data-value', value);
    li.innerHTML = '<p>' + value + '</p><span class="token-input-delete-token">x</span>';
    list.insertBefore(li, typed.parentElement);
    typed.value = '';
    refresh();
  });
  document.addEventListener('click', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('token-input-delete-token')) {
      e.target.parentElement.remove();
      refresh();
    }
  });
})();
(function () {
  var zone = document.getElementById('mainUpload');
  var input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.className = 'dz-hidden-input';
  input.style.display = 'none';
  zone.appendChild(input);
  zone.addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () {
    Array.prototype.slice.call(input.files).forEach(function (file) {
      var fd = new FormData();
      fd.append('files', file, file.name);
      fd.append('uploadKeywords', document.getElementById('mainUploadUploadKeywordTk').value);
      fd.append('folderId', document.getElementById('mainUploadUploadFolderId').value);
      fd.append('submit', 'upload');
      var endpoint = '/apps/news?page=mediaService&format=json&id=' + document.querySelector('input[name="ID"]').value;
      fetch(endpoint, { method: 'POST', body: fd })
        .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
        .then(function (res) {
          var msg = document.getElementById('mainUploaduploadMessages');
          msg.textContent = (res.body.messages || []).join('; ');
          if (res.status >= 400 || !res.body.assets) return;
          res.body.assets.forEach(function (a) {
            document.getElementById('assetContentTableBody').insertAdjacentHTML('beforeend', '<tr><td>' + a.name + '</td></tr>');
          });
        });
    });
    input.value = '';
  });
})();
`;

function editorScript(noEditor: boolean): string {
  if (noEditor) return "";
  return `
window.CKEDITOR = { instances: { TEXT: {
  setData: function (h) { document.getElementById('TEXT').value = h; },
  getData: function () { return document.getElementById('TEXT').value; }
} } };
`;
}

function layout(body: string, script = ""): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>DLRG ISC (Mock)</title></head><body>${body}<script>${script}</script></body></html>`;
}

function loginPage(failed: boolean): string {
  const alert = failed ? '<div class="alert alert-danger">Benutzername oder Passwort falsch</div>' : "";
  return layout(`
<form name="Login" method="POST" action="/">
  <input type="hidden" name="csrf" value="csrf-test">
  <input type="text" name="auth[user]">
  <input type="password" id="passwordInput" name="auth[pass]">
  <input type="checkbox" id="stayLoggedInBig" name="auth[stayLoggedIn]" checked>
  <button type="submit">Anmelden</button>
</form>${alert}`);
}

function homePage(edv: string): string {
  const name = GLIEDERUNG_NAMES[edv] ?? "Unbekannt";
  return layout(`
<nav>
  <a id="navbarDropdownMenuLink" title="${esc(name)} (${edv})" href="#">Gliederung</a>
  <div id="gldPickerMenu">
    <a class="dropdown-item ${edv === MOCK_EDV ? "active" : ""}" href="#">Ortsgruppe Andernach e.V. (${MOCK_EDV})</a>
    <a class="dropdown-item ${edv === OTHER_EDV ? "active" : ""}" href="#">Zweite Gliederung (${OTHER_EDV})</a>
  </div>
  <form id="changeGliederung" method="POST" action="/">
    <input type="hidden" id="edvnummer" name="edvnummer" value="">
  </form>
  <a id="LogoutButton" href="/logout">Abmelden</a>
</nav>
<h1>Startseite</h1>`);
}

function newsPage(news: MockNews | undefined, options: MockOptions, alert = ""): string {
  const id = news?.id ?? -1;
  const selected = (value: string): string => (news?.type === value ? " selected" : "");
  const categories = MOCK_CATEGORIES.map(
    (c) => `<option value="${c.value}"${news?.categories.includes(c.value) ? " selected" : ""}>${esc(c.name)}</option>`,
  ).join("");
  const assets = (news?.assets ?? [])
    .map((a) => `<tr><td>${esc(a.name)}</td></tr>`)
    .join("");
  const locked = news && news.status === "gesperrt" ? '<span class="status"><i class="fa-lock"></i> gesperrt</span>' : "";
  const social = `<textarea id="social-text">${esc(options.socialText ?? `Neu: ${news?.title ?? ""}`)}</textarea>`;
  const textValue = news?.html ?? "";
  const releaseBlock =
    news && news.status === "gesperrt"
      ? `<form id="releaseForm" method="POST" action="/apps/news?page=uebersicht&action=release&ID=${news.id}"><button type="submit" id="release">Veröffentlichen</button></form>`
      : "";
  const formErr = options.formError ? `<ul><li>${esc(options.formError)}</li></ul>` : "";
  return layout(
    `
<ul class="nav"><li><a href="#tab-start">News</a></li><li><a href="#tab-asset">Medien</a></li><li><a href="#tab-social">Social-Media</a></li></ul>
${alert}
${locked}
<form name="newsForm" method="POST" action="/apps/news?page=uebersicht">
  <input type="hidden" name="csrf" value="csrf-test">
  <input type="hidden" name="ID" value="${id}">
  <input type="hidden" name="tabId" value="tab-test">
  <div id="tab-start" class="tab-pane">
    <input id="STARTDATE" name="STARTDATE" type="datetime-local" value="2026-10-05T10:00">
    <input id="ARCHIVEDATE" name="ARCHIVEDATE" type="datetime-local">
    <input id="ENDDATE" name="ENDDATE" type="datetime-local">
    <select id="TYP" name="TYP">
      <option value="0"${selected("text")}>Text</option>
      <option value="1"${selected("link")}>Link</option>
      <option value="2"${selected("typo3")}>TYPO3 Link</option>
    </select>
    <select id="CATEGORIES__" name="CATEGORIES[]" multiple>${categories}</select>
    <input id="TITLE" name="TITLE" value="${esc(news?.title ?? "")}">
    <div id="nt0" class="type-block"><textarea id="TEXT" name="TEXT" data-ckeditor-config="standard">${esc(textValue)}</textarea></div>
    <div id="nt1" class="type-block" style="display:none"><input id="LINK" name="LINK" type="url"></div>
    <div id="nt2" class="type-block" style="display:none"><input id="TYPO3ID" name="TYPO3ID" type="number"></div>
    <textarea id="SUBTITLE" name="SUBTITLE">${esc(news?.subtitle ?? "")}</textarea>
    <input id="AUTHOR" name="AUTHOR" value="DLRG Andernach e.V./cdi">
    <input id="AUTHOR_EMAIL" name="AUTHOR_EMAIL" value="kommunikation@andernach.dlrg.de">
    <div class="parsley-errors-list">${formErr}</div>
    <button type="submit" id="save" name="save" value="1">Speichern</button>
  </div>
  <div id="tab-asset" class="tab-pane" style="display:none">
    <input type="checkbox" id="disallowResizeImage" name="disallowResizeImage"${news?.disallowResize ? " checked" : ""}>
    <input type="checkbox" id="firstAssetOnlyTeaser" name="firstAssetOnlyTeaser"${news?.firstAssetOnlyTeaser ? " checked" : ""}>
    <button type="button" id="uploadRibbonButton">Medien hochladen</button>
    <div id="uploadRibbon" style="display:none">
      <div id="mainUpload">
        <input type="hidden" id="mainUploadUploadKeywordTk" name="uploadKeywords" value="">
        <ul class="token-input-list"><li class="token-input-input-li"><input class="token-input-input-token" type="text"></li></ul>
        <input type="hidden" id="mainUploadUploadFolderId" name="folderId" value="">
      </div>
      <div id="mainUploaduploadMessages"></div>
    </div>
    <table><tbody id="assetContentTableBody">${assets}</tbody></table>
  </div>
  <div id="tab-social" class="tab-pane" style="display:none">${social}</div>
</form>
<div id="releaseArea">${releaseBlock}</div>`,
    SCRIPT + editorScript(options.noEditor === true),
  );
}

function successAlert(text: string): string {
  return `<div class="alert alert-success">${text}</div>`;
}

export async function startMockIsc(options: MockOptions = {}): Promise<MockIsc> {
  const news: MockNews[] = [];
  const requests: string[] = [];
  let nextId = options.startNewsId ?? 1000;
  let nextAsset = 1;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const jar = cookies(req.headers.cookie);
    const loggedIn = jar.isc_session === "1";
    const gld = jar.isc_gld ?? options.initialEdv ?? MOCK_EDV;
    requests.push(`${req.method} ${url.pathname}${url.search.includes("page=") ? `?${url.searchParams.get("page")}` : ""}`);

    const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    const sendJson = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readForm = (cb: (form: URLSearchParams) => void): void => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => cb(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    };

    if (url.pathname === "/" && req.method === "GET") {
      return send(200, loggedIn ? homePage(gld) : loginPage(false));
    }
    if (url.pathname === "/" && req.method === "POST") {
      return readForm((form) => {
        const edv = form.get("edvnummer");
        if (edv !== null) {
          if (options.failSwitch) return redirect(res, "/", { isc_session: "1", isc_gld: gld });
          const target = edv.replace(/#gld$/, "");
          return redirect(res, "/", { isc_session: "1", isc_gld: target });
        }
        if (form.get("auth[user]") === MOCK_USER && form.get("auth[pass]") === MOCK_PASS && !options.failLogin) {
          return redirect(res, "/", { isc_session: "1", isc_gld: options.initialEdv ?? MOCK_EDV });
        }
        return send(200, loginPage(true));
      });
    }
    if (url.pathname === "/logout") {
      return redirect(res, "/", { isc_session: "", isc_gld: "" });
    }
    if (!loggedIn) {
      return send(200, loginPage(false));
    }
    if (url.pathname === "/apps/news" && url.searchParams.get("page") === "uebersicht" && url.searchParams.has("create") && req.method === "GET") {
      return send(200, newsPage(undefined, options));
    }
    if (url.pathname === "/apps/news" && url.searchParams.get("page") === "finder" && req.method === "GET") {
      const needle = (url.searchParams.get("str") ?? "").toLocaleLowerCase("de-DE");
      const db = url.searchParams.get("db") ?? "";
      const hits = news
        .filter((n) => n.db === db && n.title.toLocaleLowerCase("de-DE").includes(needle))
        .map((n) => [n.title, n.id]);
      return sendJson(200, hits);
    }
    if (url.pathname === "/apps/news" && url.searchParams.get("page") === "mediaService" && req.method === "POST") {
      const id = Number(url.searchParams.get("id"));
      const target = news.find((n) => n.id === id);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (!target) return sendJson(404, { messages: ["Unbekannte News"] });
        const raw = Buffer.concat(chunks).toString("latin1");
        const fileName = /filename="([^"]+)"/.exec(raw)?.[1] ?? "unbekannt";
        const keywords = /name="uploadKeywords"\r\n\r\n([^\r]*)\r\n/.exec(raw)?.[1] ?? "";
        if (options.failUploadFor && fileName.includes(options.failUploadFor)) {
          return sendJson(500, { messages: [`Datei ${fileName} wurde abgelehnt`] });
        }
        const asset: MockAsset = { id: `asset-${nextAsset++}`, name: fileName, keywords };
        target.assets.push(asset);
        return sendJson(200, { messages: [`${fileName} gespeichert`], assets: [{ id: asset.id, name: asset.name }] });
      });
      return;
    }
    if (url.pathname === "/apps/news" && url.searchParams.get("page") === "uebersicht" && url.searchParams.get("action") === "release" && req.method === "POST") {
      const id = Number(url.searchParams.get("ID"));
      const target = news.find((n) => n.id === id);
      if (!target) return send(404, "nicht gefunden");
      target.status = "veroeffentlicht";
      return send(200, newsPage(target, options, successAlert("Erfolgreich veröffentlicht!")));
    }
    if (url.pathname === "/apps/news" && url.searchParams.get("page") === "uebersicht" && req.method === "POST") {
      return readForm((form) => {
        const requestedId = Number(form.get("ID"));
        const title = form.get("TITLE") ?? "";
        const existing = news.find((n) => n.id === requestedId);
        const record: MockNews = existing ?? {
          id: nextId++,
          db: gld,
          title: "",
          subtitle: "",
          html: "",
          type: "text",
          categories: [],
          status: "gesperrt",
          disallowResize: false,
          firstAssetOnlyTeaser: false,
          assets: [],
        };
        record.title = title;
        record.subtitle = form.get("SUBTITLE") ?? "";
        record.html = form.get("TEXT") ?? "";
        record.type = form.get("TYP") === "1" ? "link" : form.get("TYP") === "2" ? "typo3" : "text";
        record.categories = form.getAll("CATEGORIES[]");
        record.disallowResize = form.has("disallowResizeImage");
        record.firstAssetOnlyTeaser = form.has("firstAssetOnlyTeaser");
        if (!existing) news.push(record);
        if (options.saveUnconfirmedFor && title.includes(options.saveUnconfirmedFor)) {
          return send(200, newsPage(record, options, '<div class="alert alert-danger">Speichern fehlgeschlagen</div>'));
        }
        return send(200, newsPage(record, options, successAlert("Erfolgreich gespeichert!")));
      });
    }
    return send(404, "nicht gefunden");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    news,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function redirect(res: http.ServerResponse, location: string, set: Record<string, string>): void {
  res.writeHead(302, {
    Location: location,
    "Set-Cookie": Object.entries(set).map(([k, v]) => `${k}=${v}; Path=/`),
  });
  res.end();
}
