import type { Page } from "playwright";
import type { Config } from "../config.js";
import { IscBotError } from "../errors.js";
import { finderUrl } from "./selectors.js";

export function normalizeTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase("de-DE");
}

export async function findDuplicate(page: Page, cfg: Config, title: string, step = "duplicate"): Promise<number | undefined> {
  const needle = title.replace(/\s+/g, " ").trim();
  if (needle.length < 3) return undefined;
  const response = await page.context().request.get(finderUrl(cfg.iscBaseUrl, cfg.gliederungEdv, needle), {
    timeout: cfg.stepTimeoutMs,
  });
  if (!response.ok()) {
    throw new IscBotError("FORM_CHANGED", `Duplikatprüfung fehlgeschlagen (HTTP ${response.status()})`, { step });
  }
  const data: unknown = await response.json().catch(() => undefined);
  if (!Array.isArray(data)) {
    throw new IscBotError("FORM_CHANGED", "Duplikatprüfung lieferte ein unerwartetes Format", { step });
  }
  for (const entry of data) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    if (normalizeTitle(entry[0]) !== normalizeTitle(needle)) continue;
    const id = Number(entry[1]);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return undefined;
}
