import type { Page } from "playwright";
import type { Config } from "../config.js";
import { IscBotError } from "../errors.js";
import { SEL } from "./selectors.js";
import { requireVisible, waitForFirst } from "./helpers.js";

export async function readNewsId(page: Page): Promise<number | undefined> {
  const raw = await page
    .locator(SEL.news.id)
    .first()
    .inputValue({ timeout: 5000 })
    .catch(() => "");
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const view = await page
    .locator(SEL.news.idView)
    .first()
    .inputValue({ timeout: 2000 })
    .catch(() => undefined);
  if (view !== undefined && view !== String(id)) return undefined;
  return id;
}

export async function saveDraft(page: Page, cfg: Config, step = "save"): Promise<number> {
  const save = page.locator(SEL.news.save);
  await requireVisible(save, cfg.stepTimeoutMs, SEL.news.save, step);
  await save.first().click({ timeout: cfg.stepTimeoutMs });
  await waitForFirst([page.locator(SEL.news.success), page.locator(SEL.news.danger)], cfg.stepTimeoutMs);

  const newsId = await readNewsId(page);
  const confirmed = (await page.locator(SEL.news.success).filter({ hasText: SEL.successText }).count()) > 0;
  const danger = (await page.locator(SEL.news.danger).count()) > 0;
  const parsley = (await page.locator(`${SEL.news.parsleyErrors} li`).count()) > 0;
  if (!confirmed || danger || parsley || newsId === undefined) {
    throw new IscBotError("SAVE_UNCONFIRMED", "Speichern wurde vom ISC nicht bestätigt", { step, newsId });
  }
  return newsId;
}
