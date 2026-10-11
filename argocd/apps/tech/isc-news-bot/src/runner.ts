import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Config, Mode } from "./config.js";
import { IscBotError, type ErrorCode } from "./errors.js";
import { type Logger } from "./logger.js";
import { RunLock } from "./mutex.js";
import { resolveCategories, type CategoryOption } from "./categories.js";
import { overallTimeoutMs } from "./timeout.js";
import type { ParsedNews } from "./validation.js";
import { login, ensureGliederung } from "./isc/session.js";
import { openCreateForm, readCategoryOptions, fillNewsForm } from "./isc/news-form.js";
import { saveDraft } from "./isc/save.js";
import { setMediaOptions, uploadImages, type UploadedImage } from "./isc/media.js";
import { findDuplicate } from "./isc/duplicates.js";
import { publishNews } from "./isc/publish.js";
import { SEL, editUrl } from "./isc/selectors.js";
import { isPlaywrightTimeout, logoutQuietly } from "./isc/helpers.js";

export type BrowserLauncher = () => Promise<Browser>;

export const launchChromium: BrowserLauncher = () =>
  chromium.launch({ headless: true, chromiumSandbox: false, args: ["--disable-dev-shm-usage"] });

export type NewsResult = {
  ok: boolean;
  mode: Mode;
  dryRun: boolean;
  newsId?: number;
  editUrl?: string;
  status?: string;
  duplicate?: boolean;
  uploaded?: UploadedImage[];
  socialText?: string;
  durationMs: number;
  step?: string;
  errorCode?: ErrorCode;
  error?: string;
  details?: string[];
  screenshotBase64?: string;
};

export type CategoriesResult =
  | { ok: true; categories: CategoryOption[]; durationMs: number }
  | { ok: false; errorCode: ErrorCode; error: string; step?: string; durationMs: number };

type RunState = { step: string; newsId: number | undefined };

type Outcome =
  | { kind: "duplicate"; newsId: number }
  | { kind: "dry-run"; screenshotBase64: string | undefined }
  | { kind: "saved"; newsId: number; uploaded: UploadedImage[]; socialText: string | undefined };

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IscBotError("TIMEOUT", `Gesamt-Timeout von ${ms} ms überschritten`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function captureScreenshot(page: Page | undefined): Promise<string | undefined> {
  if (!page || page.isClosed()) return undefined;
  try {
    const buffer = await page.screenshot({ type: "png", timeout: 5000 });
    return buffer.toString("base64");
  } catch {
    return undefined;
  }
}

function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof IscBotError) return error.code;
  if (isPlaywrightTimeout(error)) return "TIMEOUT";
  return "INTERNAL";
}

export class IscNewsRunner {
  constructor(
    private readonly cfg: Config,
    private readonly launch: BrowserLauncher,
    private readonly lock: RunLock,
    private readonly log: Logger,
  ) {}

  async createNews(news: ParsedNews): Promise<NewsResult> {
    const started = Date.now();
    const releaseLock = await this.lock.acquire();
    const state: RunState = { step: "start", newsId: undefined };
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      browser = await this.launch();
      context = await browser.newContext({
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        viewport: { width: 1366, height: 900 },
        acceptDownloads: false,
      });
      page = await context.newPage();
      page.setDefaultTimeout(this.cfg.stepTimeoutMs);
      const deadlineMs = overallTimeoutMs(news.images.length, this.cfg.uploadSettleMs);
      const outcome = await withDeadline(this.runCreate(page, news, state), deadlineMs);
      return this.success(outcome, news, started);
    } catch (error) {
      const screenshotBase64 = await captureScreenshot(page);
      return this.failure(error, state, news, started, screenshotBase64);
    } finally {
      await this.cleanup(page, context, browser);
      releaseLock();
    }
  }

  async listCategories(): Promise<CategoriesResult> {
    const started = Date.now();
    const releaseLock = await this.lock.acquire();
    const state: RunState = { step: "start", newsId: undefined };
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      browser = await this.launch();
      context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Berlin" });
      page = await context.newPage();
      page.setDefaultTimeout(this.cfg.stepTimeoutMs);
      const categories = await withDeadline(
        (async () => {
          state.step = "login";
          await login(page as Page, this.cfg);
          state.step = "gliederung";
          await ensureGliederung(page as Page, this.cfg);
          state.step = "form";
          await openCreateForm(page as Page, this.cfg);
          return readCategoryOptions(page as Page, this.cfg);
        })(),
        overallTimeoutMs(0, this.cfg.uploadSettleMs),
      );
      await logoutQuietly(page);
      return { ok: true, categories, durationMs: Date.now() - started };
    } catch (error) {
      this.log.error("Kategorien konnten nicht gelesen werden", { step: state.step, errorCode: errorCodeOf(error) });
      return {
        ok: false,
        errorCode: errorCodeOf(error),
        error: this.log.redact(error instanceof Error ? error.message : String(error)),
        step: (error as IscBotError).step ?? state.step,
        durationMs: Date.now() - started,
      };
    } finally {
      await this.cleanup(page, context, browser);
      releaseLock();
    }
  }

  private async runCreate(page: Page, news: ParsedNews, state: RunState): Promise<Outcome> {
    const cfg = this.cfg;

    state.step = "login";
    await login(page, cfg);

    state.step = "gliederung";
    await ensureGliederung(page, cfg);

    if (!news.force) {
      state.step = "duplicate";
      const existing = await findDuplicate(page, cfg, news.title);
      if (existing !== undefined) {
        await logoutQuietly(page);
        return { kind: "duplicate", newsId: existing };
      }
    }

    state.step = "form";
    await openCreateForm(page, cfg);
    const categoryValues = resolveCategories(news.categories, await readCategoryOptions(page, cfg));
    await fillNewsForm(page, news, categoryValues, cfg);

    if (news.dryRun) {
      state.step = "dry-run";
      const screenshotBase64 = await captureScreenshot(page);
      await logoutQuietly(page);
      return { kind: "dry-run", screenshotBase64 };
    }

    state.step = "save";
    const newsId = await saveDraft(page, cfg);
    state.newsId = newsId;

    let uploaded: UploadedImage[] = [];
    if (news.images.length > 0) {
      state.step = "media";
      await page.locator(SEL.tabs.asset).first().click({ timeout: cfg.stepTimeoutMs });
      if (await setMediaOptions(page, news, cfg)) {
        state.step = "save-media-options";
        await saveDraft(page, cfg, "save-media-options");
        await page.locator(SEL.tabs.asset).first().click({ timeout: cfg.stepTimeoutMs });
      }
      state.step = "upload";
      uploaded = await uploadImages(page, cfg, newsId, news.images, "upload");
    }

    let socialText: string | undefined;
    if (news.mode === "publish") {
      state.step = "publish";
      socialText = await publishNews(page, cfg);
    }

    state.step = "logout";
    await logoutQuietly(page);
    return { kind: "saved", newsId, uploaded, socialText };
  }

  private success(outcome: Outcome, news: ParsedNews, started: number): NewsResult {
    const durationMs = Date.now() - started;
    if (outcome.kind === "duplicate") {
      this.log.info("Duplikat erkannt, nichts angelegt", { newsId: outcome.newsId, durationMs });
      return { ok: true, mode: news.mode, dryRun: false, duplicate: true, newsId: outcome.newsId, editUrl: editUrl(this.cfg.iscBaseUrl, outcome.newsId), durationMs };
    }
    if (outcome.kind === "dry-run") {
      this.log.info("Dry-Run abgeschlossen, nichts gespeichert", { images: news.images.length, durationMs });
      return { ok: true, mode: news.mode, dryRun: true, ...(outcome.screenshotBase64 ? { screenshotBase64: outcome.screenshotBase64 } : {}), durationMs };
    }
    this.log.info("News angelegt", {
      newsId: outcome.newsId,
      mode: news.mode,
      images: news.images.length,
      uploaded: outcome.uploaded.length,
      durationMs,
    });
    return {
      ok: true,
      mode: news.mode,
      dryRun: false,
      newsId: outcome.newsId,
      editUrl: editUrl(this.cfg.iscBaseUrl, outcome.newsId),
      status: news.mode === "publish" ? "veroeffentlicht" : "gesperrt",
      uploaded: outcome.uploaded,
      ...(outcome.socialText !== undefined ? { socialText: outcome.socialText } : {}),
      durationMs,
    };
  }

  private failure(error: unknown, state: RunState, news: ParsedNews, started: number, screenshotBase64: string | undefined): NewsResult {
    const durationMs = Date.now() - started;
    const code = errorCodeOf(error);
    const iscError = error instanceof IscBotError ? error : undefined;
    const newsId = iscError?.newsId ?? state.newsId;
    const step = iscError?.step ?? state.step;
    const message = this.log.redact(error instanceof Error ? error.message : String(error));
    this.log.error("Lauf fehlgeschlagen", { errorCode: code, step, newsId, durationMs, mode: news.mode });
    return {
      ok: false,
      mode: news.mode,
      dryRun: news.dryRun,
      ...(newsId !== undefined ? { newsId, editUrl: editUrl(this.cfg.iscBaseUrl, newsId) } : {}),
      errorCode: code,
      step,
      error: message,
      ...(iscError && iscError.details.length > 0 ? { details: iscError.details } : {}),
      ...(screenshotBase64 ? { screenshotBase64 } : {}),
      durationMs,
    };
  }

  private async cleanup(page: Page | undefined, context: BrowserContext | undefined, browser: Browser | undefined): Promise<void> {
    await withDeadline(logoutQuietly(page), 5000).catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
