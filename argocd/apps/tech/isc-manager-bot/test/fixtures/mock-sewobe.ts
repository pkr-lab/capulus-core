import http from "node:http";
import type { AddressInfo } from "node:net";
import { totpCode, TOTP_PERIOD_MS } from "../../src/totp.js";

export const SEWOBE_USER = "sewobe-testuser";
export const SEWOBE_PASS = "sewobe-testpass-platzhalter";
export const SEWOBE_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

export type SewobeMockPerson = {
  id: number;
  vorname: string;
  nachname: string;
  anrede: "" | "Herr" | "Frau" | "Divers" | "Keine Anrede";
  geburtstag: string;
  nr: string;
  strasse: string;
  plz: string;
  ort: string;
  land: string;
  active: boolean;
};

export type SewobeMockOptions = {
  persons?: SewobeMockPerson[];
  rejectCodes?: number;
  failLogin?: boolean;
  searchDelayMs?: number;
};

export type MockSewobe = {
  baseUrl: string;
  submittedCodes: string[];
  searches: () => number;
  logins: () => number;
  logouts: () => number;
  close: () => Promise<void>;
};

export function sewobePerson(overrides: Partial<SewobeMockPerson> = {}): SewobeMockPerson {
  return {
    id: 1,
    vorname: "Erika",
    nachname: "Musterfrau",
    anrede: "Frau",
    geburtstag: "17.05.1990",
    nr: "1002011000001",
    strasse: "Hauptstraße 1",
    plz: "56626",
    ort: "Andernach",
    land: "Deutschland",
    active: true,
    ...overrides,
  };
}

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

export async function startMockSewobe(options: SewobeMockOptions = {}): Promise<MockSewobe> {
  const persons = options.persons ?? [];
  const pending = new Set<string>();
  const sessions = new Set<string>();
  const submittedCodes: string[] = [];
  let rejectLeft = options.rejectCodes ?? 0;
  let searchCount = 0;
  let loginCount = 0;
  let logoutCount = 0;

  function validCode(code: string): boolean {
    const now = Date.now();
    return [now - TOTP_PERIOD_MS, now, now + TOTP_PERIOD_MS].some((t) => totpCode(SEWOBE_TOTP_SECRET, t) === code);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const jar = cookies(req.headers.cookie);
    const html = (body: string): void => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
    };
    const json = (body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(200, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/login" && req.method === "POST") {
      const data = JSON.parse(await readBody(req)) as { user?: string; pass?: string };
      if (!options.failLogin && data.user === SEWOBE_USER && data.pass === SEWOBE_PASS) {
        const token = `p${Math.random().toString(36).slice(2)}`;
        pending.add(token);
        return json({ ok: true }, { "Set-Cookie": `pre=${token}; Path=/` });
      }
      return json({ ok: false });
    }
    if (url.pathname === "/2fa" && req.method === "POST") {
      const data = JSON.parse(await readBody(req)) as { code?: string };
      const code = data.code ?? "";
      submittedCodes.push(code);
      const pre = jar.pre;
      if (rejectLeft > 0) {
        rejectLeft -= 1;
        return json({ ok: false });
      }
      if (pre && pending.has(pre) && validCode(code)) {
        const token = `s${Math.random().toString(36).slice(2)}`;
        sessions.add(token);
        loginCount += 1;
        return json({ ok: true }, { "Set-Cookie": `sw=${token}; Path=/` });
      }
      return json({ ok: false });
    }
    if (url.pathname === "/logout") {
      req.resume();
      if (jar.sw) sessions.delete(jar.sw);
      logoutCount += 1;
      res.writeHead(303, { Location: "/", "Set-Cookie": "sw=; Path=/; Max-Age=0" });
      return res.end();
    }

    const authed = jar.sw !== undefined && sessions.has(jar.sw);

    if (url.pathname === "/" && !authed) {
      req.resume();
      if (jar.pre && pending.has(jar.pre)) {
        return html(`<form name="twofa"><input id="2FA" name="2FA">
<button id="LOGIN" type="button" onclick="send()">Anmeldecode prüfen</button><button id="LOGIN" type="button">Abbrechen</button></form>
<script>function send(){fetch('/2fa',{method:'POST',body:JSON.stringify({code:document.getElementById('2FA').value})}).then(function(r){return r.json();}).then(function(j){location.reload();});}</script>`);
      }
      return html(`<form name="formular"><input id="USERNAME" name="USERNAME"><input id="PASSWORT" name="PASSWORT" type="password">
<button type="button" onclick="senden()">Anmelden</button><button type="button">Mit DLRG Account anmelden</button></form>
<script>function senden(){fetch('/login',{method:'POST',body:JSON.stringify({user:document.getElementById('USERNAME').value,pass:document.getElementById('PASSWORT').value})}).then(function(){location.reload();});}</script>`);
    }
    if (!authed) {
      req.resume();
      res.writeHead(403);
      return res.end();
    }
    req.resume();

    if (url.pathname === "/") {
      return html(`<input id="SEARCH"><button id="logout" onclick="location.href='/logout'">Abmelden</button>
<select id="HIERARCHIE"><option>1002011 Andernach e.V.</option></select>
<iframe id="iframemain" name="MAIN" src="/frame-main"></iframe>
<script>document.getElementById('SEARCH').addEventListener('keydown',function(e){if(e.key==='Enter'){document.getElementById('iframemain').src='/frame-main?q='+encodeURIComponent(this.value);}});</script>`);
    }
    if (url.pathname === "/frame-main") {
      const q = url.searchParams.get("q") ?? "";
      return html(`<iframe id="SEARCHCONTENT" name="SEARCHCONTENT" src="/search?q=${encodeURIComponent(q)}"></iframe>`);
    }
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") ?? "";
      const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = q === "" ? [] : persons.filter((p) => tokens.every((t) => `${p.vorname} ${p.nachname} ${p.nr}`.toLowerCase().includes(t)));
      if (q !== "") searchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, options.searchDelayMs ?? 0));
      const cards = hits
        .map(
          (p) => `<div class="card contacts"><div class="basissatz-row">
<div class="status"><i class="fas fa-circle ${p.active ? "cl-success status_aktiv" : "cl-danger status_passiv"}"></i></div>
<div class="company">${esc(p.nachname)}, ${esc(p.vorname)}</div><div class="hkat">Mitglied</div><div class="nr">${p.nr}</div>
<a href="/module/adressen/personen.php?APADR_ID=${p.id}&amp;BSADR_ID=${p.id}" target="_blank">Kontakt öffnen</a></div></div>`,
        )
        .join("");
      return html(`<div>Suchbegriff: ${esc(q)}</div>${hits.length > 0 ? cards : '<div class="emptyresponse">Geben Sie oben links Ihren Suchparameter ein</div>'}`);
    }
    if (url.pathname === "/module/adressen/personen.php") {
      const id = url.searchParams.get("APADR_ID");
      const found = persons.find((p) => String(p.id) === id);
      if (!found) return html("<p>unbekannt</p>");
      return html(`<h1 class="contactname">${esc(found.anrede)} ${esc(found.vorname)} ${esc(found.nachname)}, Nr.: ${found.nr}</h1>
<iframe id="DETAIL" name="DETAIL" src="/detail?id=${found.id}"></iframe>`);
    }
    if (url.pathname === "/detail") {
      const found = persons.find((p) => String(p.id) === url.searchParams.get("id"));
      if (!found) return html("<p>unbekannt</p>");
      const anreden = ["", "Frau", "Herr", "Divers", "Keine Anrede"];
      const laender = Array.from(new Set(["Deutschland", "Österreich", "Schweiz", found.land]));
      return html(`<form id="formular">
<select id="BS_ANREDE" name="BS_ANREDE">${anreden.map((a) => `<option${a === found.anrede ? " selected" : ""}>${a}</option>`).join("")}</select>
<input id="BS_VORNAME" name="BS_VORNAME" value="${esc(found.vorname)}"><input id="BS_NAME" name="BS_NAME" value="${esc(found.nachname)}">
<select id="LAND_ID" name="LAND_ID">${laender.map((l) => `<option${l === found.land ? " selected" : ""}>${l}</option>`).join("")}</select>
<input id="PLZ" name="PLZ" value="${esc(found.plz)}"><input id="ORT" name="ORT" value="${esc(found.ort)}">
<textarea id="STRASSE" name="STRASSE">${esc(found.strasse)}</textarea>
<input id="GEBURTSTAG" name="GEBURTSTAG" value="${esc(found.geburtstag)}">
</form>`);
    }
    res.writeHead(404);
    return res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    submittedCodes,
    searches: () => searchCount,
    logins: () => loginCount,
    logouts: () => logoutCount,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
