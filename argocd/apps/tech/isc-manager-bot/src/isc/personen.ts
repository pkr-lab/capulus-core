import type { Page } from "playwright";
import type { Config } from "../config.js";
import { BotError } from "../errors.js";
import { isPlaywrightTimeout, requireAttached, requireVisible, waitForFirst } from "../pw.js";
import { collapse, normalizeName } from "../text.js";
import { isoPrefix } from "../datetime.js";
import { matchPerson } from "../sync/matching.js";
import type { AddressValues, Candidate, GrunddatenValues, IscAddress, IscState, Target } from "../sync/types.js";
import { ISC } from "./selectors.js";

type CountryOption = { value: string; text: string };

const URL_PATTERN_ROW = /^personlocationrow(\d+)$/;

function iscUrl(cfg: Config, path: string): string {
  return `${cfg.iscBaseUrl}${path}`;
}

async function waitForLoad(page: Page, action: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.all([page.waitForEvent("load", { timeout: timeoutMs }), action()]);
}

async function invalidFields(page: Page, formSelector: string): Promise<string[]> {
  return page.locator(`${formSelector} .parsley-error`).evaluateAll((els) => els.map((el) => el.id || el.getAttribute("name") || "unbekannt"));
}

async function setSelectValue(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).first().evaluate((el, wanted) => {
    const select = el as HTMLSelectElement;
    const jq = (window as unknown as { jQuery?: (target: Element) => { selectpicker?: (cmd: string, val: string) => unknown } }).jQuery;
    const wrapped = jq ? jq(select) : undefined;
    if (wrapped?.selectpicker) {
      wrapped.selectpicker("val", wanted);
    } else {
      select.value = wanted;
    }
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function chooseGender(page: Page, formSelector: string, value: string, timeoutMs: number): Promise<void> {
  const radio = page.locator(`${formSelector} input[name=gender][value="${value}"]`).first();
  await radio.waitFor({ state: "attached", timeout: timeoutMs });
  const id = await radio.getAttribute("id");
  const label = id ? page.locator(`${formSelector} label[for="${id}"], ${formSelector} label#gender${value}Label`).first() : undefined;
  if (label && (await label.isVisible())) {
    await label.click({ timeout: timeoutMs });
  } else {
    await radio.evaluate((el) => (el as HTMLInputElement).click());
  }
}

async function readCountryOptions(page: Page, selector: string): Promise<CountryOption[]> {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => ({ value: (el as HTMLOptionElement).value, text: (el as HTMLOptionElement).text })),
  );
}

export function resolveCountry(options: CountryOption[], land: string): string {
  const wanted = normalizeName(land);
  const hit = options.find((option) => option.value !== "" && normalizeName(option.text) === wanted);
  if (!hit) {
    throw new BotError("LAND_UNBEKANNT", "Das Land aus SEWOBE existiert im ISC nicht in der Auswahlliste", { step: "isc-address" });
  }
  return hit.value;
}

export async function loadCandidates(page: Page, cfg: Config, target: Target): Promise<Candidate[]> {
  const step = "isc-match";
  await page.goto(iscUrl(cfg, ISC.urls.list), { waitUntil: "domcontentloaded", timeout: cfg.stepTimeoutMs });
  const result = await page.evaluate(
    async (args) => {
      const norm = (value: unknown): string =>
        String(value ?? "")
          .normalize("NFC")
          .replace(/\s+/g, " ")
          .trim()
          .toLocaleLowerCase("de-DE");
      const response = await fetch(args.url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body: "limit=20000",
      });
      if (!response.ok) return { error: `HTTP ${response.status}`, rows: [] as Record<string, string>[] };
      const json = (await response.json()) as { status?: unknown; data?: unknown };
      if (!Array.isArray(json.data)) return { error: "Antwort ohne Personenliste", rows: [] as Record<string, string>[] };
      const rows: Record<string, string>[] = [];
      for (const row of json.data as Record<string, unknown>[]) {
        const id = String(row.dlrgManagerId ?? "").trim();
        const gebDate = String(row.gebDate ?? "").slice(0, 10);
        const nameMatch = norm(row.vorname) === args.vorname && norm(row.name) === args.nachname && gebDate === args.gebdate;
        if ((id !== "" && id === args.id) || nameMatch) {
          rows.push({ uid: String(row.uid), vorname: String(row.vorname ?? ""), nachname: String(row.name ?? ""), gebdate: gebDate, dlrgManagerId: id });
        }
      }
      return { error: "", rows };
    },
    {
      url: ISC.urls.listData,
      id: target.dlrgManagerId,
      vorname: normalizeName(target.vorname),
      nachname: normalizeName(target.nachname),
      gebdate: target.gebdate,
    },
  );
  if (result.error !== "") throw new BotError("FORM_CHANGED", `Personenliste des ISC nicht lesbar (${result.error})`, { step });
  return result.rows.map((row) => ({
    uid: row.uid ?? "",
    vorname: row.vorname ?? "",
    nachname: row.nachname ?? "",
    gebdate: row.gebdate ?? "",
    dlrgManagerId: row.dlrgManagerId ?? "",
  }));
}

async function readAddress(page: Page, cfg: Config): Promise<IscAddress | undefined> {
  const rows = page.locator(ISC.address.rows);
  const entries = await rows.evaluateAll((els, typeName) =>
    els
      .map((el) => ({ id: el.id, text: (el.textContent ?? "").replace(/\s+/g, " ") }))
      .filter((entry) => entry.text.includes(typeName)),
  ISC.address.privateType);
  let best: { locId: string; rowId: string } | undefined;
  for (const entry of entries) {
    const match = URL_PATTERN_ROW.exec(entry.id);
    if (!match?.[1]) continue;
    if (!best || Number(match[1]) > Number(best.locId)) best = { locId: match[1], rowId: entry.id };
  }
  if (!best) return undefined;

  const row = page.locator(`[id="${best.rowId}"]`);
  await row.locator(ISC.address.editButton).first().click({ timeout: cfg.stepTimeoutMs });
  await page.locator(`${ISC.address.locId}[value="${best.locId}"]`).first().waitFor({ state: "attached", timeout: cfg.stepTimeoutMs });
  await page.waitForFunction(
    (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.value !== undefined,
    ISC.address.strasse,
    { timeout: cfg.stepTimeoutMs },
  );
  const read = (selector: string): Promise<string> => page.locator(selector).first().inputValue({ timeout: cfg.stepTimeoutMs });
  const land = await page.locator(ISC.address.country).first().evaluate((el) => {
    const select = el as HTMLSelectElement;
    return select.selectedOptions[0]?.text ?? "";
  });
  return {
    locId: best.locId,
    strasse: await read(ISC.address.strasse),
    plz: await read(ISC.address.plz),
    ort: await read(ISC.address.ort),
    land,
  };
}

async function hasMembership(page: Page, cfg: Config): Promise<boolean> {
  const wanted = normalizeName(cfg.mitgliedschaftGliederung);
  const texts = await page.locator(ISC.membership.rows).evaluateAll((els) => els.map((el) => el.textContent ?? ""));
  return texts.some((text) => normalizeName(text).includes(wanted));
}

async function readGrunddaten(page: Page, cfg: Config): Promise<Omit<IscState, "hasMembership" | "address">> {
  const step = "isc-read";
  await requireAttached(page.locator(ISC.grunddaten.form), cfg.stepTimeoutMs, "Grunddaten-Formular im ISC", step);
  const read = (selector: string): Promise<string> => page.locator(selector).first().inputValue({ timeout: cfg.stepTimeoutMs });
  const checked = page.locator(ISC.grunddaten.genderChecked);
  const gender = (await checked.count()) > 0 ? await checked.first().inputValue() : "";
  return {
    vorname: await read(ISC.grunddaten.vorname),
    nachname: await read(ISC.grunddaten.nachname),
    gebdate: isoPrefix(await read(ISC.grunddaten.gebdate)),
    gender,
    dlrgManagerId: (await read(ISC.grunddaten.managerId)).trim(),
  };
}

export async function openPerson(page: Page, cfg: Config, uid: string): Promise<void> {
  await page.goto(iscUrl(cfg, ISC.urls.edit(uid)), { waitUntil: "domcontentloaded", timeout: cfg.stepTimeoutMs });
  await requireAttached(page.locator(ISC.grunddaten.form), cfg.stepTimeoutMs, "Grunddaten-Formular im ISC", "isc-read");
}

export async function readState(page: Page, cfg: Config, uid: string): Promise<IscState> {
  await openPerson(page, cfg, uid);
  const grunddaten = await readGrunddaten(page, cfg);
  const membership = await hasMembership(page, cfg);
  const address = await readAddress(page, cfg);
  return { ...grunddaten, hasMembership: membership, address };
}

export async function saveGrunddaten(page: Page, cfg: Config, uid: string, values: GrunddatenValues): Promise<void> {
  const step = "isc-save";
  await openPerson(page, cfg, uid);
  const fill = async (selector: string, value: string): Promise<void> => {
    await requireVisible(page.locator(selector), cfg.stepTimeoutMs, selector, step);
    await page.locator(selector).first().fill(value, { timeout: cfg.stepTimeoutMs });
  };
  if (values.vorname !== undefined) await fill(ISC.grunddaten.vorname, values.vorname);
  if (values.nachname !== undefined) await fill(ISC.grunddaten.nachname, values.nachname);
  if (values.gebdate !== undefined) await fill(ISC.grunddaten.gebdate, values.gebdate);
  if (values.dlrgManagerId !== undefined) await fill(ISC.grunddaten.managerId, values.dlrgManagerId);
  if (values.gender !== undefined) await chooseGender(page, ISC.grunddaten.form, values.gender, cfg.stepTimeoutMs);

  await page.locator(ISC.grunddaten.submit).first().click({ timeout: cfg.stepTimeoutMs });
  const outcome = await waitForFirst(
    [page.locator(ISC.grunddaten.success), page.locator(ISC.grunddaten.danger), page.locator(ISC.grunddaten.invalid)],
    cfg.saveTimeoutMs,
    "attached",
  );
  if (outcome === 1) throw new BotError("SAVE_FAILED", "ISC meldet einen Fehler beim Speichern der Grunddaten", { step });
  if (outcome === 2) {
    throw new BotError("FORM_INVALID", "ISC lehnt Grunddaten als ungültig ab", { step, details: await invalidFields(page, ISC.grunddaten.form) });
  }

  await openPerson(page, cfg, uid);
  const after = await readGrunddaten(page, cfg);
  const mismatch: string[] = [];
  if (values.vorname !== undefined && collapse(after.vorname) !== collapse(values.vorname)) mismatch.push("vorname");
  if (values.nachname !== undefined && collapse(after.nachname) !== collapse(values.nachname)) mismatch.push("nachname");
  if (values.gebdate !== undefined && after.gebdate !== values.gebdate) mismatch.push("geburtsdatum");
  if (values.gender !== undefined && after.gender !== values.gender) mismatch.push("geschlecht");
  if (values.dlrgManagerId !== undefined && after.dlrgManagerId !== values.dlrgManagerId) mismatch.push("dlrgManagerId");
  if (mismatch.length > 0) {
    throw new BotError("SAVE_UNCONFIRMED", "ISC zeigt nach dem Speichern andere Grunddaten als gesetzt", { step, details: mismatch });
  }
}

export async function saveAddress(page: Page, cfg: Config, uid: string, kind: "update" | "create", values: AddressValues): Promise<void> {
  const step = "isc-address";
  await openPerson(page, cfg, uid);
  const countryValue = resolveCountry(await readCountryOptions(page, ISC.address.countryOptions), values.land);

  if (kind === "update") {
    const current = await readAddress(page, cfg);
    if (!current) throw new BotError("FORM_CHANGED", "Bestehende Adresse im ISC nicht mehr auffindbar", { step });
  } else {
    await page.locator("button, a").filter({ hasText: ISC.address.newButton }).first().click({ timeout: cfg.stepTimeoutMs });
    await requireVisible(page.locator(ISC.address.strasse), cfg.stepTimeoutMs, "Adressformular", step);
    await setSelectValue(page, ISC.address.typ, ISC.address.privateTypeValue);
  }
  await requireVisible(page.locator(ISC.address.strasse), cfg.stepTimeoutMs, "Adressformular", step);
  await page.locator(ISC.address.strasse).first().fill(values.strasse, { timeout: cfg.stepTimeoutMs });
  await page.locator(ISC.address.plz).first().fill(values.plz, { timeout: cfg.stepTimeoutMs });
  await page.locator(ISC.address.ort).first().fill(values.ort, { timeout: cfg.stepTimeoutMs });
  await setSelectValue(page, ISC.address.country, countryValue);

  try {
    await waitForLoad(page, () => page.locator(ISC.address.submit).first().click({ timeout: cfg.stepTimeoutMs }), cfg.saveTimeoutMs);
  } catch (error) {
    if (!isPlaywrightTimeout(error)) throw error;
    const invalid = await invalidFields(page, ISC.address.form).catch(() => [] as string[]);
    if (invalid.length > 0) throw new BotError("FORM_INVALID", "ISC lehnt die Adresse als ungültig ab", { step, details: invalid });
    throw new BotError("SAVE_UNCONFIRMED", "Keine Bestätigung des ISC beim Speichern der Adresse", { step });
  }

  await openPerson(page, cfg, uid);
  const after = await readAddress(page, cfg);
  const mismatch: string[] = [];
  if (!after || collapse(after.strasse) !== collapse(values.strasse)) mismatch.push("strasse");
  if (!after || collapse(after.plz) !== collapse(values.plz)) mismatch.push("plz");
  if (!after || collapse(after.ort) !== collapse(values.ort)) mismatch.push("ort");
  if (!after || normalizeName(after.land) !== normalizeName(values.land)) mismatch.push("land");
  if (mismatch.length > 0) {
    throw new BotError("SAVE_UNCONFIRMED", "ISC zeigt nach dem Speichern eine andere Adresse als gesetzt", { step, details: mismatch });
  }
}

async function stepAction<T>(step: string, what: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isPlaywrightTimeout(error)) throw new BotError("FORM_CHANGED", `Zeitüberschreitung bei: ${what}`, { step });
    throw error;
  }
}

async function pickGliederung(page: Page, cfg: Config, inputSelector: string, edvSelector: string, step: string): Promise<void> {
  const input = page.locator(inputSelector).first();
  await stepAction(step, "Klick ins Gliederungsfeld", () => input.click({ timeout: cfg.stepTimeoutMs }));
  await stepAction(step, "Eingabe der Gliederung", () => input.pressSequentially(`${cfg.mitgliedschaftSuchbegriff} `, { delay: 40 }));
  const suggestionText = new RegExp(`${cfg.mitgliedschaftGliederung.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+-\\s+\\d{5}`);
  const suggestion = page.getByText(suggestionText).filter({ visible: true }).first();
  try {
    await suggestion.waitFor({ state: "visible", timeout: cfg.stepTimeoutMs });
  } catch (error) {
    if (isPlaywrightTimeout(error)) throw new BotError("FORM_CHANGED", "Gliederungsvorschlag erscheint im ISC nicht", { step });
    throw error;
  }
  await stepAction(step, "Klick auf den Gliederungsvorschlag", () => suggestion.click({ timeout: cfg.stepTimeoutMs }));
  const edv = await stepAction(step, "Lesen der EDV-Nummer der Gliederung", () => page.locator(edvSelector).first().inputValue({ timeout: cfg.stepTimeoutMs }));
  if (edv !== cfg.gliederungEdv) {
    throw new BotError("FORM_CHANGED", "Gliederungsauswahl hat nicht die erwartete EDV-Nummer gesetzt", { step });
  }
}

export async function addMembership(page: Page, cfg: Config, uid: string): Promise<void> {
  const step = "isc-membership";
  await openPerson(page, cfg, uid);
  await stepAction(step, "Klick auf Neue Mitgliedschaft", () =>
    page.locator("button, a").filter({ hasText: ISC.membership.newButton }).first().click({ timeout: cfg.stepTimeoutMs }),
  );
  await requireVisible(page.locator(ISC.membership.gliederung), cfg.stepTimeoutMs, "Mitgliedschaftsformular", step);
  await pickGliederung(page, cfg, ISC.membership.gliederung, ISC.membership.edv, step);
  try {
    await waitForLoad(page, () => page.locator(ISC.membership.submit).first().click({ timeout: cfg.stepTimeoutMs }), cfg.saveTimeoutMs);
  } catch (error) {
    if (!isPlaywrightTimeout(error)) throw error;
    const invalid = await invalidFields(page, ISC.membership.form).catch(() => [] as string[]);
    if (invalid.length > 0) throw new BotError("FORM_INVALID", "ISC lehnt die Mitgliedschaft als ungültig ab", { step, details: invalid });
    throw new BotError("SAVE_UNCONFIRMED", "Keine Bestätigung des ISC beim Speichern der Mitgliedschaft", { step });
  }
  await openPerson(page, cfg, uid);
  if (!(await hasMembership(page, cfg))) {
    throw new BotError("SAVE_UNCONFIRMED", "Mitgliedschaft ist nach dem Speichern im ISC nicht sichtbar", { step });
  }
}

export async function readCreateCountryOptions(page: Page, cfg: Config): Promise<CountryOption[]> {
  await page.goto(iscUrl(cfg, ISC.urls.create), { waitUntil: "domcontentloaded", timeout: cfg.stepTimeoutMs });
  await requireAttached(page.locator(ISC.create.form), cfg.stepTimeoutMs, "Formular für neue Person", "isc-create");
  return readCountryOptions(page, ISC.create.countryOptions);
}

export async function createPerson(page: Page, cfg: Config, target: Target, values: AddressValues | undefined): Promise<string> {
  const step = "isc-create";
  if (target.gender === undefined) throw new BotError("GESCHLECHT_FEHLT", "Geschlecht fehlt für die Neuanlage", { step });
  const options = await readCreateCountryOptions(page, cfg);
  const countryValue = values ? resolveCountry(options, values.land) : undefined;

  const fill = async (selector: string, value: string): Promise<void> => {
    await requireVisible(page.locator(selector), cfg.stepTimeoutMs, selector, step);
    await page.locator(selector).first().fill(value, { timeout: cfg.stepTimeoutMs });
  };
  await fill(ISC.create.vorname, target.vorname);
  await fill(ISC.create.nachname, target.nachname);
  await fill(ISC.create.gebdate, target.gebdate);
  await fill(ISC.create.managerId, target.dlrgManagerId);
  await chooseGender(page, ISC.create.form, target.gender, cfg.stepTimeoutMs);
  if (values) {
    await fill(ISC.create.strasse, values.strasse);
    await fill(ISC.create.plz, values.plz);
    await fill(ISC.create.ort, values.ort);
    if (countryValue !== undefined) await setSelectValue(page, ISC.create.country, countryValue);
  }
  await pickGliederung(page, cfg, ISC.create.gliederung, ISC.create.edv, step);

  try {
    await waitForLoad(page, () => page.locator(ISC.create.submit).first().click({ timeout: cfg.stepTimeoutMs }), cfg.saveTimeoutMs);
  } catch (error) {
    if (!isPlaywrightTimeout(error)) throw error;
    const invalid = await invalidFields(page, ISC.create.form).catch(() => [] as string[]);
    if (invalid.length > 0) throw new BotError("FORM_INVALID", "ISC lehnt die neue Person als ungültig ab", { step, details: invalid });
    throw new BotError("SAVE_UNCONFIRMED", "Keine Bestätigung des ISC beim Anlegen der Person", { step });
  }

  const match = matchPerson(await loadCandidates(page, cfg, target), target);
  if (match.kind !== "byId") {
    throw new BotError("SAVE_UNCONFIRMED", "Neu angelegte Person ist im ISC nicht auffindbar", { step });
  }
  return match.uid;
}

export async function membershipPresent(page: Page, cfg: Config, uid: string): Promise<boolean> {
  await openPerson(page, cfg, uid);
  return hasMembership(page, cfg);
}
