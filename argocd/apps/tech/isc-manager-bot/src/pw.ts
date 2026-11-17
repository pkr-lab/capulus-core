import type { Locator, Page } from "playwright";
import { BotError } from "./errors.js";

export function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export async function requireAttached(locator: Locator, timeoutMs: number, what: string, step: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
  } catch (error) {
    if (isPlaywrightTimeout(error)) {
      throw new BotError("FORM_CHANGED", `Element nicht gefunden: ${what}`, { step });
    }
    throw error;
  }
}

export async function requireVisible(locator: Locator, timeoutMs: number, what: string, step: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    if (isPlaywrightTimeout(error)) {
      throw new BotError("FORM_CHANGED", `Element nicht sichtbar: ${what}`, { step });
    }
    throw error;
  }
}

export async function waitForFirst(locators: Locator[], timeoutMs: number, state: "visible" | "attached" = "visible"): Promise<number> {
  const attempts = locators.map((locator, index) =>
    locator
      .first()
      .waitFor({ state, timeout: timeoutMs })
      .then(() => index),
  );
  try {
    return await Promise.any(attempts);
  } catch {
    return -1;
  }
}

export async function clickAndSettle(page: Page, click: () => Promise<unknown>, navigationWaitMs = 10_000): Promise<void> {
  const navigated = page
    .waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: navigationWaitMs })
    .catch(() => undefined);
  await click();
  await navigated;
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}
