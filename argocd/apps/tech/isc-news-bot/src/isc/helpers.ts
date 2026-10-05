import type { Locator, Page } from "playwright";
import { IscBotError } from "../errors.js";

export function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export async function requireAttached(locator: Locator, timeoutMs: number, what: string, step: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
  } catch (error) {
    if (isPlaywrightTimeout(error)) {
      throw new IscBotError("FORM_CHANGED", `Element nicht gefunden: ${what}`, { step });
    }
    throw error;
  }
}

export async function requireVisible(locator: Locator, timeoutMs: number, what: string, step: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    if (isPlaywrightTimeout(error)) {
      throw new IscBotError("FORM_CHANGED", `Element nicht sichtbar: ${what}`, { step });
    }
    throw error;
  }
}

export async function waitForFirst(locators: Locator[], timeoutMs: number): Promise<number> {
  const attempts = locators.map((locator, index) =>
    locator
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => index),
  );
  try {
    return await Promise.any(attempts);
  } catch {
    return -1;
  }
}

export async function fillField(page: Page, selector: string, value: string, timeoutMs: number, step: string): Promise<void> {
  const locator = page.locator(selector);
  await requireVisible(locator, timeoutMs, selector, step);
  await locator.first().fill(value, { timeout: timeoutMs });
}

export async function selectOptionValue(page: Page, selector: string, value: string, timeoutMs: number, step: string): Promise<void> {
  const locator = page.locator(selector);
  await requireAttached(locator, timeoutMs, selector, step);
  await locator.first().selectOption(value, { timeout: timeoutMs });
}

export async function logoutQuietly(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return;
  try {
    const logout = page.locator("#LogoutButton");
    if ((await logout.count()) > 0) {
      await logout.first().click({ timeout: 5000 });
    }
  } catch {
    return;
  }
}
