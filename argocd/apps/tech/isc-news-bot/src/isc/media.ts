import type { Page } from "playwright";
import type { Config } from "../config.js";
import { IscBotError } from "../errors.js";
import type { DecodedImage } from "../images.js";
import type { ParsedNews } from "../validation.js";
import { SEL } from "./selectors.js";
import { requireAttached, requireVisible } from "./helpers.js";

export type UploadedImage = { fileName: string; ok: true; messages: string[] };

function messagesOf(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("messages" in body)) return [];
  const raw = (body as { messages: unknown }).messages;
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => (typeof m === "string" ? m : JSON.stringify(m)).slice(0, 300));
}

export async function setMediaOptions(page: Page, news: ParsedNews, cfg: Config, step = "media"): Promise<boolean> {
  const wanted: Array<[string, boolean]> = [
    [SEL.media.disallowResize, news.disallowResizeImage],
    [SEL.media.firstAssetOnlyTeaser, news.firstAssetOnlyTeaser],
  ];
  let changed = false;
  for (const [selector, value] of wanted) {
    const box = page.locator(selector).first();
    await requireAttached(box, cfg.stepTimeoutMs, selector, step);
    if ((await box.isChecked()) !== value) {
      await box.setChecked(value, { timeout: cfg.stepTimeoutMs });
      changed = true;
    }
  }
  return changed;
}

async function setKeywords(page: Page, keywords: string[], cfg: Config, step: string): Promise<void> {
  for (let guard = 0; guard < 50; guard++) {
    const tokens = page.locator(SEL.media.keywordDelete);
    if ((await tokens.count()) === 0) break;
    await tokens.first().click({ timeout: cfg.stepTimeoutMs });
  }
  const input = page.locator(SEL.media.keywordTokenInput).first();
  await requireVisible(input, cfg.stepTimeoutMs, SEL.media.keywordTokenInput, step);
  for (const keyword of keywords) {
    await input.fill(keyword, { timeout: cfg.stepTimeoutMs });
    await input.press("Enter", { timeout: cfg.stepTimeoutMs });
  }
  const applied = (await page.locator(SEL.media.keywordValue).first().inputValue({ timeout: cfg.stepTimeoutMs }))
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  const same = applied.length === keywords.length && keywords.every((k) => applied.includes(k));
  if (!same) {
    throw new IscBotError("UPLOAD_FAILED", `Schlagworte wurden nicht übernommen (erwartet ${keywords.join(",")})`, { step });
  }
}

async function sendFile(page: Page, image: DecodedImage, cfg: Config): Promise<void> {
  const file = { name: image.fileName, mimeType: image.mimeType, buffer: image.buffer };
  const input = page.locator(SEL.media.dropzoneInput);
  if ((await input.count()) > 0) {
    await input.first().setInputFiles(file, { timeout: cfg.stepTimeoutMs });
    return;
  }
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: cfg.stepTimeoutMs }),
    page.locator(SEL.media.dropzone).first().click({ timeout: cfg.stepTimeoutMs }),
  ]);
  await chooser.setFiles(file);
}

export async function uploadImages(page: Page, cfg: Config, newsId: number, images: DecodedImage[], step = "upload"): Promise<UploadedImage[]> {
  await page.locator(SEL.media.uploadRibbonButton).first().click({ timeout: cfg.stepTimeoutMs });
  await requireVisible(page.locator(SEL.media.uploadRibbon), cfg.stepTimeoutMs, SEL.media.uploadRibbon, step);
  const results: UploadedImage[] = [];

  for (const image of images) {
    await setKeywords(page, image.keywords, cfg, step);
    const rowsBefore = await page.locator(SEL.media.assetRows).count();
    const responsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("page=mediaService"),
      { timeout: cfg.stepTimeoutMs },
    );
    await sendFile(page, image, cfg);
    const response = await responsePromise.catch(() => undefined);
    if (!response) {
      throw new IscBotError("UPLOAD_FAILED", `Keine Antwort des Medien-Dienstes für ${image.fileName}`, { step, newsId });
    }
    const body: unknown = await response.json().catch(() => undefined);
    const messages = messagesOf(body);
    const assets = typeof body === "object" && body !== null && "assets" in body ? (body as { assets: unknown }).assets : undefined;
    if (!response.ok() || !Array.isArray(assets) || assets.length === 0) {
      throw new IscBotError("UPLOAD_FAILED", `Upload von ${image.fileName} abgelehnt (HTTP ${response.status()})`, {
        step,
        newsId,
        details: messages,
      });
    }
    const rowAppeared = await page
      .waitForFunction(([selector, before]: [string, number]) => document.querySelectorAll(selector).length > before, [SEL.media.assetRows, rowsBefore] as [string, number], {
        timeout: cfg.stepTimeoutMs,
      })
      .then(() => true)
      .catch(() => false);
    if (!rowAppeared) {
      throw new IscBotError("UPLOAD_FAILED", `Bild ${image.fileName} erscheint nicht in der Medienliste`, { step, newsId, details: messages });
    }
    await page.waitForTimeout(cfg.uploadSettleMs);
    results.push({ fileName: image.fileName, ok: true, messages });
  }
  return results;
}
