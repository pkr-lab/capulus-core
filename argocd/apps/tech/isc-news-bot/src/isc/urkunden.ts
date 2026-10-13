import type { Page } from "playwright";
import type { Config } from "../config.js";
import { IscBotError } from "../errors.js";
import { isPlaywrightTimeout } from "./helpers.js";

export const URKUNDEN_SEITE = "/apps/urkunden?page=uebersicht";
export const URKUNDEN_SERVICE = "/apps/urkunden?page=service";
export const URKUNDEN_AKTION = "ladeUrkundenListe";

type Antwort = { ok: true; data: unknown } | { ok: false; error: string };

export async function ladeUrkundenListe(page: Page, cfg: Config, jahr: string, step = "urkunden"): Promise<unknown[]> {
  await page.goto(`${cfg.iscBaseUrl}${URKUNDEN_SEITE}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => typeof (window as unknown as Record<string, unknown>).dlrg_DoPost === "function", null, {
      timeout: cfg.stepTimeoutMs,
    });
  } catch (error) {
    if (isPlaywrightTimeout(error)) {
      throw new IscBotError("FORM_CHANGED", "Urkunden-App ohne dlrg_DoPost, keine Berechtigung oder Seite geändert", { step });
    }
    throw error;
  }

  const antwort = await page.evaluate(
    ({ service, aktion, jahr, timeoutMs }) =>
      new Promise<Antwort>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: `Keine Antwort von ${aktion} nach ${timeoutMs} ms` }), timeoutMs);
        const post = (window as unknown as { dlrg_DoPost: (...args: unknown[]) => void }).dlrg_DoPost;
        try {
          post(
            service,
            aktion,
            { jahr, ausbildungId: "", inaktiveAnzeigen: false, mitVerlaengerungen: false },
            (data: unknown) => {
              clearTimeout(timer);
              resolve({ ok: true, data });
            },
            () => {
              clearTimeout(timer);
              resolve({ ok: false, error: `${aktion} meldet einen Fehler` });
            },
          );
        } catch (error) {
          clearTimeout(timer);
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    { service: URKUNDEN_SERVICE, aktion: URKUNDEN_AKTION, jahr, timeoutMs: cfg.stepTimeoutMs },
  );

  if (!antwort.ok) throw new IscBotError("FORM_CHANGED", antwort.error, { step });
  if (!Array.isArray(antwort.data)) {
    throw new IscBotError("FORM_CHANGED", `${URKUNDEN_AKTION} lieferte keine Liste`, { step });
  }
  return antwort.data;
}
