import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Config } from "./config.js";
import { BotError, type ErrorCode } from "./errors.js";
import type { Logger } from "./logger.js";
import { RunLock } from "./mutex.js";
import { isPlaywrightTimeout } from "./pw.js";
import { scrubMessage } from "./text.js";
import { TotpSource } from "./totp.js";
import type { ParsedSync } from "./validation.js";
import { sewobeLogin, sewobeLogoutQuietly } from "./sewobe/session.js";
import { readPerson } from "./sewobe/person.js";
import { searchHits, selectHit } from "./sewobe/search.js";
import { iscEnsureGliederung, iscLogin, iscLogoutQuietly } from "./isc/session.js";
import {
  addMembership,
  createPerson,
  loadCandidates,
  membershipPresent,
  readCreateCountryOptions,
  readState,
  resolveCountry,
  saveAddress,
  saveGrunddaten,
} from "./isc/personen.js";
import { matchPerson } from "./sync/matching.js";
import { toTarget } from "./sync/mapping.js";
import { planCreate, planUpdate } from "./sync/plan.js";
import type { FieldChange, Plan, SyncOutcome, Target } from "./sync/types.js";

export type BrowserLauncher = () => Promise<Browser>;

export const launchChromium: BrowserLauncher = () =>
  chromium.launch({ headless: true, chromiumSandbox: false, args: ["--disable-dev-shm-usage"] });

export type SyncResult = {
  ok: boolean;
  result: SyncOutcome;
  dryRun: boolean;
  changedFields?: string[];
  diff?: FieldChange[];
  warnings?: string[];
  reason?: string;
  errorCode?: ErrorCode;
  step?: string;
  error?: string;
  details?: string[];
  durationMs: number;
};

export type SyncApi = {
  sync(request: ParsedSync): Promise<SyncResult>;
};

type Sessions = {
  isc: Page;
  sewobe: Page;
};

type Outcome = {
  result: Exclude<SyncOutcome, "error">;
  changes: FieldChange[];
  warnings: string[];
  reason?: string;
};

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BotError("TIMEOUT", `Gesamt-Timeout von ${ms} ms überschritten`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof BotError) return error.code;
  if (isPlaywrightTimeout(error)) return "TIMEOUT";
  return "INTERNAL";
}

function safeMessage(error: unknown, step: string): string {
  if (error instanceof BotError) return scrubMessage(error.message);
  if (isPlaywrightTimeout(error)) return `Zeitüberschreitung im Schritt ${step}`;
  const name = error instanceof Error ? error.name : "unbekannt";
  return `Unerwarteter Fehler im Schritt ${step} (${name})`;
}

export class SyncRunner {
  constructor(
    private readonly cfg: Config,
    private readonly launch: BrowserLauncher,
    private readonly lock: RunLock,
    private readonly log: Logger,
    private readonly totp: TotpSource,
  ) {}

  async sync(request: ParsedSync): Promise<SyncResult> {
    const started = Date.now();
    const releaseLock = await this.lock.acquire();
    const state = { step: "start" };
    let browser: Browser | undefined;
    let iscContext: BrowserContext | undefined;
    let sewobeContext: BrowserContext | undefined;
    let sessions: Sessions | undefined;
    try {
      browser = await this.launch();
      const options = { locale: "de-DE", timezoneId: "Europe/Berlin", viewport: { width: 1366, height: 900 }, acceptDownloads: false };
      iscContext = await browser.newContext(options);
      sewobeContext = await browser.newContext(options);
      sessions = { isc: await iscContext.newPage(), sewobe: await sewobeContext.newPage() };
      sessions.isc.setDefaultTimeout(this.cfg.stepTimeoutMs);
      sessions.sewobe.setDefaultTimeout(this.cfg.stepTimeoutMs);
      const outcome = await withDeadline(this.run(sessions, request, state), this.cfg.syncTimeoutMs);
      return this.success(outcome, request, started);
    } catch (error) {
      return this.failure(error, state.step, request, started);
    } finally {
      await this.cleanup(sessions, iscContext, sewobeContext, browser);
      releaseLock();
    }
  }

  private async run(sessions: Sessions, request: ParsedSync, state: { step: string }): Promise<Outcome> {
    const cfg = this.cfg;

    state.step = "isc-login";
    await iscLogin(sessions.isc, cfg);
    state.step = "isc-gliederung";
    await iscEnsureGliederung(sessions.isc, cfg);

    state.step = "sewobe-login";
    await sewobeLogin(sessions.sewobe, cfg, this.totp);

    state.step = "sewobe-search";
    const hits = await searchHits(sessions.sewobe, cfg, request.vorname, request.nachname);
    const selection = selectHit(hits, request.vorname, request.nachname, request.mitgliedsnummer);
    if (selection.kind === "inactive") {
      return { result: "skipped", changes: [], warnings: [], reason: "Person in SEWOBE nicht aktiv (zum Beispiel ausgetreten)" };
    }

    state.step = "sewobe-person";
    const target = toTarget(await readPerson(sessions.sewobe, cfg, selection.hit));

    state.step = "isc-match";
    const match = matchPerson(await loadCandidates(sessions.isc, cfg, target), target);

    const warnings: string[] = [];
    let uid: string | undefined;
    let plan: Plan;
    if (match.kind === "none") {
      plan = planCreate(target, cfg.mitgliedschaftGliederung);
      if (request.dryRun && plan.address.kind !== "none") {
        resolveCountry(await readCreateCountryOptions(sessions.isc, cfg), plan.address.values.land);
      }
    } else {
      uid = match.uid;
      state.step = "isc-read";
      plan = planUpdate(await readState(sessions.isc, cfg, uid), target, cfg.mitgliedschaftGliederung);
      if (target.gender === undefined) warnings.push("GESCHLECHT_NICHT_GESETZT");
    }

    if (request.dryRun) {
      return { result: this.outcomeOf(match.kind === "none", plan), changes: plan.changes, warnings };
    }

    if (match.kind === "none") {
      state.step = "isc-create";
      const address = plan.address.kind === "none" ? undefined : plan.address.values;
      const createdUid = await createPerson(sessions.isc, cfg, target, address);
      state.step = "isc-membership";
      if (!(await membershipPresent(sessions.isc, cfg, createdUid))) {
        await addMembership(sessions.isc, cfg, createdUid);
      }
      return { result: "created", changes: plan.changes, warnings };
    }

    await this.apply(sessions.isc, uid ?? "", plan, state);
    return { result: this.outcomeOf(false, plan), changes: plan.changes, warnings };
  }

  private outcomeOf(isNew: boolean, plan: Plan): "created" | "updated" | "unchanged" {
    if (isNew) return "created";
    return plan.changes.length > 0 ? "updated" : "unchanged";
  }

  private async apply(page: Page, uid: string, plan: Plan, state: { step: string }): Promise<void> {
    if (Object.keys(plan.grunddaten).length > 0) {
      state.step = "isc-save";
      await saveGrunddaten(page, this.cfg, uid, plan.grunddaten);
    }
    if (plan.address.kind !== "none") {
      state.step = "isc-address";
      await saveAddress(page, this.cfg, uid, plan.address.kind, plan.address.values);
    }
    if (plan.membership) {
      state.step = "isc-membership";
      await addMembership(page, this.cfg, uid);
    }
  }

  private success(outcome: Outcome, request: ParsedSync, started: number): SyncResult {
    const durationMs = Date.now() - started;
    const changedFields = outcome.changes.map((change) => change.field);
    this.log.info("Abgleich abgeschlossen", {
      result: outcome.result,
      dryRun: request.dryRun,
      changedCount: changedFields.length,
      durationMs,
    });
    return {
      ok: true,
      result: outcome.result,
      dryRun: request.dryRun,
      ...(outcome.result === "created" || outcome.result === "updated" ? { changedFields } : {}),
      ...(request.dryRun ? { diff: outcome.changes } : {}),
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      durationMs,
    };
  }

  private failure(error: unknown, runStep: string, request: ParsedSync, started: number): SyncResult {
    const durationMs = Date.now() - started;
    const code = errorCodeOf(error);
    const botError = error instanceof BotError ? error : undefined;
    const step = botError?.step ?? runStep;
    const message = this.log.redact(safeMessage(error, step));
    this.log.error("Abgleich fehlgeschlagen", { errorCode: code, step, dryRun: request.dryRun, durationMs });
    return {
      ok: false,
      result: "error",
      dryRun: request.dryRun,
      errorCode: code,
      step,
      error: message,
      reason: message,
      ...(botError && botError.details.length > 0 ? { details: botError.details.map((d) => this.log.redact(d)) } : {}),
      durationMs,
    };
  }

  private async cleanup(
    sessions: Sessions | undefined,
    iscContext: BrowserContext | undefined,
    sewobeContext: BrowserContext | undefined,
    browser: Browser | undefined,
  ): Promise<void> {
    await withDeadline(iscLogoutQuietly(sessions?.isc), 8000).catch(() => undefined);
    await withDeadline(sewobeLogoutQuietly(sessions?.sewobe, this.cfg.sewobeBaseUrl), 15_000).catch(() => undefined);
    await iscContext?.close().catch(() => undefined);
    await sewobeContext?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export type { Target };
