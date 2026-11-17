import type { Page } from "playwright";
import type { Config } from "../config.js";
import { BotError } from "../errors.js";
import { clickAndSettle, requireAttached, waitForFirst } from "../pw.js";
import { ISC } from "./selectors.js";

export function parseEdv(text: string): string | undefined {
  const match = /\((\d{5,9})\)/.exec(text);
  return match?.[1];
}

async function readActiveEdv(page: Page): Promise<string | undefined> {
  const title = await page.locator(ISC.gliederung.navbarTitle).first().getAttribute("title", { timeout: 5000 }).catch(() => null);
  const fromTitle = title ? parseEdv(title) : undefined;
  if (fromTitle) return fromTitle;
  const item = page.locator(ISC.gliederung.activeItem).first();
  if ((await item.count()) === 0) return undefined;
  return parseEdv(await item.innerText({ timeout: 5000 }).catch(() => ""));
}

export async function iscLogin(page: Page, cfg: Config): Promise<void> {
  const step = "isc-login";
  await page.goto(`${cfg.iscBaseUrl}/`, { waitUntil: "domcontentloaded" }).catch(() => {
    throw new BotError("LOGIN_UNEXPECTED", "Login-Seite des ISC nicht erreichbar", { step });
  });
  const loginForm = page.locator(ISC.login.form);
  const logout = page.locator(ISC.logout);

  const initial = await waitForFirst([logout, loginForm], cfg.stepTimeoutMs);
  if (initial === 0) return;
  if (initial !== 1) throw new BotError("LOGIN_UNEXPECTED", "Weder Login-Formular noch Startseite des ISC erkannt", { step });

  await page.locator(ISC.login.user).fill(cfg.iscUsername, { timeout: cfg.stepTimeoutMs });
  await page.locator(ISC.login.pass).fill(cfg.iscPassword, { timeout: cfg.stepTimeoutMs });
  const stayLoggedIn = page.locator(ISC.login.stayLoggedIn);
  if ((await stayLoggedIn.count()) > 0 && (await stayLoggedIn.first().isChecked())) {
    await stayLoggedIn.first().uncheck({ timeout: cfg.stepTimeoutMs });
  }
  await loginForm.getByRole("button", { name: ISC.login.submitText }).click({ timeout: cfg.stepTimeoutMs });

  const after = await waitForFirst([logout, loginForm], cfg.stepTimeoutMs);
  if (after === 0) return;
  if (after === 1) throw new BotError("LOGIN_FAILED", "Anmeldung am ISC abgelehnt: Login-Formular ist weiterhin sichtbar", { step });
  throw new BotError("LOGIN_UNEXPECTED", "Nach der Anmeldung am ISC unerwartete Seite", { step });
}

export async function iscEnsureGliederung(page: Page, cfg: Config): Promise<void> {
  const step = "isc-gliederung";
  if ((await readActiveEdv(page)) === cfg.gliederungEdv) return;

  const input = page.locator(ISC.gliederung.changeInput);
  await requireAttached(input, cfg.stepTimeoutMs, ISC.gliederung.changeInput, step);
  await input.first().evaluate((el, value) => {
    (el as HTMLInputElement).value = value;
  }, `${cfg.gliederungEdv}${ISC.gliederung.edvSuffix}`);

  const form = page.locator(ISC.gliederung.changeForm).first();
  await requireAttached(form, cfg.stepTimeoutMs, ISC.gliederung.changeForm, step);
  await Promise.all([
    page.waitForEvent("framenavigated", { timeout: 5000 }).catch(() => undefined),
    form.evaluate((f) => (f as HTMLFormElement).requestSubmit()),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  const after = await readActiveEdv(page);
  if (after !== cfg.gliederungEdv) {
    throw new BotError("WRONG_GLIEDERUNG", `Aktive Gliederung im ISC ist ${after ?? "unbekannt"}, erwartet ${cfg.gliederungEdv}`, { step });
  }
}

export async function iscLogoutQuietly(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return;
  try {
    const logout = page.locator(ISC.logout);
    if ((await logout.count()) > 0) {
      await clickAndSettle(page, () => logout.first().click({ timeout: 5000 }), 5000);
    }
  } catch {
    return;
  }
}
