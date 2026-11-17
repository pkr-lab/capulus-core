import http from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_USER = "isc-testuser";
export const MOCK_PASS = "isc-testpass-platzhalter";
export const MOCK_EDV = "1002011";
export const OTHER_EDV = "2000002";
export const MOCK_GLIEDERUNG = "Ortsgruppe Andernach e.V.";

export type MockAddress = { id: number; typ: string; strasse: string; plz: string; ort: string; country: string };

export type MockPerson = {
  uid: number;
  vorname: string;
  name: string;
  gebDate: string;
  gender: "" | "0" | "1" | "2";
  dlrgManagerId: string;
  memberships: string[];
  addresses: MockAddress[];
};

export type MockOptions = {
  persons?: MockPerson[];
  activeEdv?: string;
  failSwitch?: boolean;
  failLogin?: boolean;
  saveUnconfirmed?: boolean;
  saveFails?: boolean;
  rejectManagerId?: boolean;
  noPersonCreate?: boolean;
  noAutoMembership?: boolean;
};

export type MockIsc = {
  baseUrl: string;
  persons: MockPerson[];
  writes: string[];
  requests: string[];
  logouts: () => number;
  loggedIn: () => number;
  close: () => Promise<void>;
};

export function person(overrides: Partial<MockPerson> = {}): MockPerson {
  return {
    uid: 1001,
    vorname: "Erika",
    name: "Musterfrau",
    gebDate: "1990-05-17",
    gender: "1",
    dlrgManagerId: "",
    memberships: [MOCK_GLIEDERUNG],
    addresses: [],
    ...overrides,
  };
}

const COUNTRIES = [
  { value: "DE", text: "Deutschland" },
  { value: "AT", text: "Österreich" },
  { value: "CH", text: "Schweiz" },
];

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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const FAKE_JQUERY = `
window.jQuery = function (el) {
  return {
    selectpicker: function (cmd, val) {
      if (cmd === 'val') { el.value = val; }
      return this;
    }
  };
};
function suggest(input, edv, list) {
  input.addEventListener('input', function () {
    list.innerHTML = '';
    edv.value = '';
    if (input.value.length > 3 && 'Ortsgruppe Andernach e.V.'.toLowerCase().indexOf(input.value.toLowerCase()) === 0) {
      var li = document.createElement('li');
      li.textContent = 'Ortsgruppe Andernach e.V. (1002011)';
      li.addEventListener('click', function () {
        input.value = 'Ortsgruppe Andernach e.V.';
        edv.value = '1002011';
        list.innerHTML = '';
      });
      list.appendChild(li);
    }
  });
}
`;

export async function startMockIsc(options: MockOptions = {}): Promise<MockIsc> {
  const persons: MockPerson[] = options.persons ?? [];
  const writes: string[] = [];
  const requests: string[] = [];
  const sessions = new Set<string>();
  let activeEdv = options.activeEdv ?? MOCK_EDV;
  let logoutCount = 0;
  let loginCount = 0;
  let nextUid = 5000;
  let nextRow = 900;

  function shell(inner: string): string {
    const title = activeEdv === MOCK_EDV ? `${MOCK_GLIEDERUNG} (${MOCK_EDV})` : `Zweite Gliederung (${OTHER_EDV})`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>ISC</title></head><body>
<nav><a id="navbarDropdownMenuLink" href="#" title="${esc(title)}">Gliederung</a>
<form id="changeGliederung" method="post" action="/switch"><input id="edvnummer" name="edvnummer" type="hidden" value=""></form>
<form method="post" action="/logout"><button id="LogoutButton" type="submit">Abmelden</button></form></nav>
${inner}</body></html>`;
  }

  function loginPage(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Login</title></head><body>
<form name="Login" method="post" action="/login">
<input name="auth[user]" type="text"><input id="passwordInput" name="auth[pass]" type="password">
<input id="stayLoggedInBig" type="checkbox" name="stay" checked>
<button type="submit">Anmelden</button></form></body></html>`;
  }

  function countrySelect(): string {
    return `<select id="country" name="country">${COUNTRIES.map((c) => `<option value="${c.value}">${c.text}</option>`).join("")}</select>`;
  }

  function genderRadios(current: string): string {
    return ["0", "1", "2"]
      .map(
        (v) =>
          `<input type="radio" name="gender" id="gender${v}" value="${v}"${current === v ? " checked" : ""}><label id="gender${v}Label" for="gender${v}">${v}</label>`,
      )
      .join("");
  }

  function editPage(p: MockPerson): string {
    const rows = p.memberships.map((m, i) => `<div id="personmembershiprow${i + 1}">Gliederung ${esc(m)}</div>`).join("");
    const addresses = p.addresses
      .map(
        (a) =>
          `<div id="personlocationrow${a.id}">Typ ${esc(a.typ)} Adresse ${esc(a.strasse)} ${esc(a.plz)} ${esc(a.ort)} <button type="button" onclick="mergeDataAndLocationForm('personlocation', ${a.id}, 'x')">Bearbeiten</button></div>`,
      )
      .join("");
    const data = JSON.stringify(p.addresses).replace(/</g, "\\u003c");
    return shell(`
<form id="persongrunddatenform" onsubmit="return false">
<input id="vorname" name="vorname" value="${esc(p.vorname)}">
<input id="nachname" name="nachname" value="${esc(p.name)}">
<input id="gebdate" name="gebdate" type="date" value="${esc(p.gebDate)}">
${genderRadios(p.gender)}
<input id="dlrgmanager_id" name="dlrgmanager_id" value="${esc(p.dlrgManagerId)}">
<button type="button" id="grunddatensubmit">Speichern</button>
<div id="persongrunddatenformindicatordiv"></div>
</form>
<div>${rows}<button type="button" onclick="document.getElementById('personmembershipform').style.display='block'">Neue Mitgliedschaft</button></div>
<form id="personmembershipform" method="post" action="/membership?uid=${p.uid}" style="display:none">
<input id="gliederung" name="gliederung" autocomplete="off"><ul id="sugg"></ul>
<input type="hidden" id="gliederungedvnummer" name="edv" value="">
<input id="mitgliedschaftsubmit" type="submit" value="Speichern">
</form>
<div>${addresses}<button type="button" onclick="resetLocationForm()">Neue Adresse</button></div>
<form id="personlocationform" method="post" action="/location?uid=${p.uid}" style="display:none">
<select id="typ" name="typ"><option value="1">Private Anschrift</option><option value="2">Sonstige</option></select>
<input type="hidden" id="locId" name="locId" value="">
<input id="strasse" name="strasse"><input id="plz" name="plz"><input id="ort" name="ort">${countrySelect()}
<input type="submit" name="locationsubmit" value="Speichern">
</form>
<script>
${FAKE_JQUERY}
var ADDRESSES = ${data};
function resetLocationForm() {
  var f = document.getElementById('personlocationform');
  f.style.display = 'block';
  document.getElementById('locId').setAttribute('value', '');
  document.getElementById('locId').value = '';
  ['strasse','plz','ort'].forEach(function (id) { document.getElementById(id).value = ''; });
}
function mergeDataAndLocationForm(kind, id) {
  var a = ADDRESSES.filter(function (x) { return x.id === id; })[0];
  var f = document.getElementById('personlocationform');
  f.style.display = 'block';
  document.getElementById('locId').setAttribute('value', String(id));
  document.getElementById('locId').value = String(id);
  document.getElementById('strasse').value = a.strasse;
  document.getElementById('plz').value = a.plz;
  document.getElementById('ort').value = a.ort;
  document.getElementById('country').value = a.country;
}
suggest(document.getElementById('gliederung'), document.getElementById('gliederungedvnummer'), document.getElementById('sugg'));
document.getElementById('grunddatensubmit').addEventListener('click', function () {
  var form = document.getElementById('persongrunddatenform');
  var mid = document.getElementById('dlrgmanager_id');
  mid.classList.remove('parsley-error');
  if (!/^\\d{0,13}$/.test(mid.value) || ${options.rejectManagerId ? "true" : "false"}) {
    mid.classList.add('parsley-error');
    return;
  }
  var checked = form.querySelector('input[name=gender]:checked');
  var body = JSON.stringify({
    vorname: document.getElementById('vorname').value,
    nachname: document.getElementById('nachname').value,
    gebdate: document.getElementById('gebdate').value,
    gender: checked ? checked.value : '',
    dlrgManagerId: mid.value
  });
  var indicator = document.getElementById('persongrunddatenformindicatordiv');
  indicator.innerHTML = '<div class="spinner">...</div>';
  fetch('/ajax/grunddaten?uid=${p.uid}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      setTimeout(function () {
        indicator.innerHTML = j.ok ? '<div class="alert alert-success">Speichern erfolgreich</div>' : '<div class="alert alert-danger">Fehler beim Speichern</div>';
      }, 300);
    });
});
</script>`);
  }

  function createPage(): string {
    return shell(`
<form id="personnewform" method="post" action="/apps/personen?page=uebersicht&action=new">
<input id="vorname" name="vorname"><input id="nachname" name="nachname"><input id="gebdate" name="gebdate" type="date">
${genderRadios("")}
<input id="dlrgmanager_id" name="dlrgmanager_id">
<input id="strasse" name="strasse"><input id="plz" name="plz"><input id="ort" name="ort">${countrySelect()}
<input id="newgliederung" name="newgliederung" autocomplete="off"><ul id="sugg"></ul>
<input type="hidden" id="newedvnummer" name="newedvnummer" value="">
<input type="submit" name="personnewsubmit" value="Anlegen">
</form>
<script>
${FAKE_JQUERY}
suggest(document.getElementById('newgliederung'), document.getElementById('newedvnummer'), document.getElementById('sugg'));
</script>`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}`);
    const sid = cookies(req.headers.cookie).sid;
    const authed = sid !== undefined && sessions.has(sid);
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    };
    const json = (body: unknown): void => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const redirect = (to: string, headers: Record<string, string> = {}): void => {
      res.writeHead(303, { Location: to, ...headers });
      res.end();
    };

    if (url.pathname === "/login" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (!options.failLogin && form.get("auth[user]") === MOCK_USER && form.get("auth[pass]") === MOCK_PASS) {
        const token = `s${Math.random().toString(36).slice(2)}`;
        sessions.add(token);
        loginCount += 1;
        return redirect("/", { "Set-Cookie": `sid=${token}; Path=/` });
      }
      return redirect("/");
    }
    if (!authed) {
      req.resume();
      return html(loginPage());
    }
    if (url.pathname === "/logout" && req.method === "POST") {
      req.resume();
      if (sid) sessions.delete(sid);
      logoutCount += 1;
      return redirect("/", { "Set-Cookie": "sid=; Path=/; Max-Age=0" });
    }
    if (url.pathname === "/switch" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (!options.failSwitch && form.get("edvnummer")?.startsWith(MOCK_EDV)) activeEdv = MOCK_EDV;
      return redirect("/");
    }
    if (url.pathname === "/apps/personen" && req.method === "POST" && url.searchParams.get("action") === "loadpersonlist") {
      req.resume();
      return json({
        status: true,
        mess: "",
        data: persons.map((p) => ({
          uid: p.uid,
          id: p.uid,
          name: p.name,
          vorname: p.vorname,
          gebDate: p.gebDate,
          dlrgManagerId: p.dlrgManagerId === "" ? null : p.dlrgManagerId,
        })),
      });
    }
    if (url.pathname === "/apps/personen" && req.method === "GET") {
      const action = url.searchParams.get("action");
      if (action === "edit") {
        const found = persons.find((p) => String(p.uid) === url.searchParams.get("uid"));
        req.resume();
        return found ? html(editPage(found)) : html(shell("<p>nicht gefunden</p>"), 404);
      }
      if (action === "new") {
        req.resume();
        return html(createPage());
      }
      req.resume();
      return html(shell("<p>Personen</p>"));
    }
    if (url.pathname === "/apps/personen" && req.method === "POST" && url.searchParams.get("action") === "new") {
      const form = new URLSearchParams(await readBody(req));
      if (!options.noPersonCreate) {
        const uid = nextUid++;
        const memberships = form.get("newedvnummer") === MOCK_EDV && !options.noAutoMembership ? [MOCK_GLIEDERUNG] : [];
        const addresses: MockAddress[] = form.get("strasse")
          ? [{ id: nextRow++, typ: "Private Anschrift", strasse: form.get("strasse") ?? "", plz: form.get("plz") ?? "", ort: form.get("ort") ?? "", country: form.get("country") ?? "DE" }]
          : [];
        persons.push({
          uid,
          vorname: form.get("vorname") ?? "",
          name: form.get("nachname") ?? "",
          gebDate: form.get("gebdate") ?? "",
          gender: (form.get("gender") ?? "") as MockPerson["gender"],
          dlrgManagerId: form.get("dlrgmanager_id") ?? "",
          memberships,
          addresses,
        });
        writes.push("create");
      }
      return html(createPage());
    }
    if (url.pathname === "/ajax/grunddaten" && req.method === "POST") {
      const data = JSON.parse(await readBody(req)) as Record<string, string>;
      const found = persons.find((p) => String(p.uid) === url.searchParams.get("uid"));
      if (!found || options.saveFails) return json({ ok: false });
      if (!options.saveUnconfirmed) {
        found.vorname = data.vorname ?? found.vorname;
        found.name = data.nachname ?? found.name;
        found.gebDate = data.gebdate ?? found.gebDate;
        found.gender = (data.gender ?? "") as MockPerson["gender"];
        found.dlrgManagerId = data.dlrgManagerId ?? "";
      }
      writes.push("grunddaten");
      return json({ ok: true });
    }
    if (url.pathname === "/membership" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const found = persons.find((p) => String(p.uid) === url.searchParams.get("uid"));
      if (found && form.get("edv") === MOCK_EDV) {
        found.memberships.push(MOCK_GLIEDERUNG);
        writes.push("membership");
      }
      return redirect(`/apps/personen?page=uebersicht&action=edit&uid=${url.searchParams.get("uid")}`);
    }
    if (url.pathname === "/location" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const found = persons.find((p) => String(p.uid) === url.searchParams.get("uid"));
      if (found) {
        const locId = form.get("locId") ?? "";
        const existing = found.addresses.find((a) => String(a.id) === locId);
        const values = { strasse: form.get("strasse") ?? "", plz: form.get("plz") ?? "", ort: form.get("ort") ?? "", country: form.get("country") ?? "DE" };
        if (existing) Object.assign(existing, values);
        else found.addresses.push({ id: nextRow++, typ: form.get("typ") === "1" ? "Private Anschrift" : "Sonstige", ...values });
        writes.push("address");
      }
      return redirect(`/apps/personen?page=uebersicht&action=edit&uid=${url.searchParams.get("uid")}`);
    }
    req.resume();
    return html(shell("<p>Start</p>"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    persons,
    writes,
    requests,
    logouts: () => logoutCount,
    loggedIn: () => loginCount,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
