import type { Page } from "playwright";
import type { Config } from "../config.js";
import { IscBotError } from "../errors.js";
import { SEL } from "./selectors.js";
import { requireAttached, waitForFirst } from "./helpers.js";

export function parseEdv(text: string): string | undefined {
  const match = /\((\d{5,9})\)/.exec(text);
  return match?.[1];
}

async function readActiveEdv(page: Page): Promise<string | undefined> {
  const title = await page.locator(SEL.gliederung.navbarTitle).first().getAttribute("title", { timeout: 5000 }).catch(() => null);
  const fromTitle = title ? parseEdv(title) : undefined;
  if (fromTitle) return fromTitle;
  const item = page.locator(SEL.gliederung.activeItem).first();
  if ((await item.count()) === 0) return undefined;
  return parseEdv(await item.innerText({ timeout: 5000 }).catch(() => ""));
}

export async function login(page: Page, cfg: Config, step = "login"): Promise<void> {
  await page.goto(`${cfg.iscBaseUrl}/`, { waitUntil: "domcontentloaded" }).catch(() => {
    throw new IscBotError("LOGIN_UNEXPECTED", "Login-Seite des ISC nicht erreichbar", { step });
  });
  const loginForm = page.locator(SEL.login.form);
  const logout = page.locator(SEL.logout);

  const initial = await waitForFirst([logout, loginForm], cfg.stepTimeoutMs);
  if (initial === 0) return;
  if (initial !== 1) {
    throw new IscBotError("LOGIN_UNEXPECTED", "Weder Login-Formular noch Startseite erkannt", { step });
  }

  await page.locator(SEL.login.user).fill(cfg.iscUsername, { timeout: cfg.stepTimeoutMs });
  await page.locator(SEL.login.pass).fill(cfg.iscPassword, { timeout: cfg.stepTimeoutMs });
  const stayLoggedIn = page.locator(SEL.login.stayLoggedIn);
  if ((await stayLoggedIn.count()) > 0 && (await stayLoggedIn.first().isChecked())) {
    await stayLoggedIn.first().uncheck({ timeout: cfg.stepTimeoutMs });
  }
  await loginForm.getByRole("button", { name: SEL.login.submitText }).click({ timeout: cfg.stepTimeoutMs });

  const after = await waitForFirst([logout, loginForm], cfg.stepTimeoutMs);
  if (after === 0) return;
  if (after === 1) {
    throw new IscBotError("LOGIN_FAILED", "Anmeldung abgelehnt: Login-Formular ist weiterhin sichtbar", { step });
  }
  throw new IscBotError("LOGIN_UNEXPECTED", "Nach der Anmeldung unerwartete Seite", { step });
}

export async function ensureGliederung(page: Page, cfg: Config, step = "gliederung"): Promise<void> {
  if ((await readActiveEdv(page)) === cfg.gliederungEdv) return;

  const input = page.locator(SEL.gliederung.changeInput);
  await requireAttached(input, cfg.stepTimeoutMs, SEL.gliederung.changeInput, step);
  await input.first().evaluate((el, value) => {
    (el as HTMLInputElement).value = value;
  }, `${cfg.gliederungEdv}${SEL.gliederung.edvSuffix}`);

  const form = page.locator(SEL.gliederung.changeForm).first();
  await requireAttached(form, cfg.stepTimeoutMs, SEL.gliederung.changeForm, step);
  await Promise.all([
    page.waitForEvent("framenavigated", { timeout: 5000 }).catch(() => undefined),
    form.evaluate((f) => (f as HTMLFormElement).requestSubmit()),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  const after = await readActiveEdv(page);
  if (after !== cfg.gliederungEdv) {
    throw new IscBotError("WRONG_GLIEDERUNG", `Aktive Gliederung ist ${after ?? "unbekannt"}, erwartet ${cfg.gliederungEdv}`, { step });
  }
}
