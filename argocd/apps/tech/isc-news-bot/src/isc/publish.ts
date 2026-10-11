import type { Page } from "playwright";
import type { Config } from "../config.js";
import { IscBotError } from "../errors.js";
import { SEL } from "./selectors.js";
import { requireVisible } from "./helpers.js";

export async function isLocked(page: Page): Promise<boolean> {
  const icons = await page.locator(SEL.news.lockIcon).count();
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return icons > 0 || text.includes(SEL.news.lockedText);
}

async function waitUntilReleased(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const success = (await page.locator(SEL.news.success).count()) > 0;
    if (success && !(await isLocked(page))) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function readSocialText(page: Page): Promise<string | undefined> {
  const tab = page.locator(SEL.tabs.social);
  if ((await tab.count()) === 0) return undefined;
  await tab.first().click({ timeout: 5000 }).catch(() => undefined);
  const text = await page
    .locator(SEL.news.socialText)
    .first()
    .evaluate((el) => ("value" in el ? String((el as HTMLTextAreaElement).value) : (el.textContent ?? "")), { timeout: 5000 })
    .catch(() => "");
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

export async function publishNews(page: Page, cfg: Config, step = "publish"): Promise<string | undefined> {
  await page.locator(SEL.tabs.start).first().click({ timeout: cfg.stepTimeoutMs });
  await requireVisible(page.locator(SEL.news.release), cfg.stepTimeoutMs, SEL.news.release, step);
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await Promise.all([
    page.waitForEvent("framenavigated", { timeout: 5000 }).catch(() => undefined),
    page.locator(SEL.news.release).first().click({ timeout: cfg.stepTimeoutMs }),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  if (!(await waitUntilReleased(page, cfg.stepTimeoutMs))) {
    throw new IscBotError("PUBLISH_FAILED", "Veröffentlichen nicht bestätigt (Status weiterhin gesperrt oder keine Erfolgsmeldung)", { step });
  }
  return readSocialText(page);
}
