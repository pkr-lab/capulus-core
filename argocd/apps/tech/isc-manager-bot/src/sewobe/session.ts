import type { Locator, Page } from "playwright";
import type { Config } from "../config.js";
import { BotError } from "../errors.js";
import type { TotpSource } from "../totp.js";
import { SEWOBE } from "./selectors.js";
import { clickAndSettle, waitForFirst } from "../pw.js";

async function readHierarchie(page: Page): Promise<string[]> {
  const select = page.locator(SEWOBE.hierarchie);
  if ((await select.count()) === 0) return [];
  return select.first().evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => o.text));
}

async function submitTwoFactor(page: Page, code: string, cfg: Config): Promise<void> {
  await page.locator(SEWOBE.twoFactor.input).first().fill(code, { timeout: cfg.stepTimeoutMs });
  await clickAndSettle(page, () =>
    page.getByRole("button", { name: SEWOBE.twoFactor.submitText, exact: true }).click({ timeout: cfg.stepTimeoutMs }),
  );
}

export async function sewobeLogin(page: Page, cfg: Config, totp: TotpSource): Promise<void> {
  const step = "sewobe-login";
  await page.goto(`${cfg.sewobeBaseUrl}/`, { waitUntil: "domcontentloaded" }).catch(() => {
    throw new BotError("LOGIN_UNEXPECTED", "Login-Seite von SEWOBE nicht erreichbar", { step });
  });
  const loginForm = page.locator(SEWOBE.login.form);
  const search = page.locator(SEWOBE.search);
  const twoFactor = page.locator(SEWOBE.twoFactor.input);

  const initial = await waitForFirst([search, loginForm], cfg.stepTimeoutMs);
  if (initial === -1) throw new BotError("LOGIN_UNEXPECTED", "Weder Login-Formular noch Startseite von SEWOBE erkannt", { step });
  if (initial === 1) {
    await page.locator(SEWOBE.login.user).fill(cfg.sewobeUsername, { timeout: cfg.stepTimeoutMs });
    await page.locator(SEWOBE.login.pass).fill(cfg.sewobePassword, { timeout: cfg.stepTimeoutMs });
    await clickAndSettle(page, () =>
      page.getByRole("button", { name: SEWOBE.login.submitText, exact: true }).click({ timeout: cfg.stepTimeoutMs }),
    );

    const afterPassword = await waitForFirst([search, twoFactor, loginForm], cfg.stepTimeoutMs);
    if (afterPassword === -1) throw new BotError("LOGIN_UNEXPECTED", "Nach der Anmeldung bei SEWOBE unerwartete Seite", { step });
    if (afterPassword === 2) throw new BotError("LOGIN_FAILED", "Anmeldung bei SEWOBE abgelehnt: Login-Formular ist weiterhin sichtbar", { step });
    if (afterPassword === 1) {
      await submitTwoFactor(page, await totp.next(), cfg);
      let after = await waitForFirst([search, twoFactor, loginForm], cfg.stepTimeoutMs);
      if (after === 1) {
        await submitTwoFactor(page, await totp.next(), cfg);
        after = await waitForFirst([search, twoFactor, loginForm], cfg.stepTimeoutMs);
      }
      if (after !== 0) {
        throw new BotError("TOTP_FAILED", "SEWOBE hat den Anmeldecode abgelehnt (auch beim zweiten Versuch)", { step });
      }
    }
  }

  const options = await readHierarchie(page);
  if (options.length > 0 && !options.some((text) => text.includes(cfg.gliederungEdv))) {
    throw new BotError("WRONG_GLIEDERUNG", `Gliederung ${cfg.gliederungEdv} ist in SEWOBE nicht auswählbar`, { step });
  }
}

export async function sewobeLogoutQuietly(page: Page | undefined, baseUrl: string): Promise<void> {
  if (!page || page.isClosed()) return;
  try {
    const logout: Locator = page.locator(SEWOBE.logout);
    if ((await logout.count()) === 0) {
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    }
    if ((await logout.count()) > 0) {
      await clickAndSettle(page, () => logout.first().click({ timeout: 5000 }), 5000);
    }
  } catch {
    return;
  }
}
