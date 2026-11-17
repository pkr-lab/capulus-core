import type { Page } from "playwright";
import type { Config } from "../config.js";
import { BotError } from "../errors.js";
import { collapse, normalizeName } from "../text.js";
import { isPlaywrightTimeout } from "../pw.js";
import { SEWOBE } from "./selectors.js";

export type Hit = {
  active: boolean;
  company: string;
  number: string;
  href: string;
};

export type Selection = { kind: "found"; hit: Hit } | { kind: "inactive" };

async function readHits(page: Page): Promise<Hit[]> {
  const frame = page.frameLocator(SEWOBE.frames.main).frameLocator(SEWOBE.frames.results);
  return frame.locator(SEWOBE.results.card).evaluateAll(
    (cards, sel) =>
      cards.map((card) => ({
        active: card.querySelector(sel.statusActive) !== null,
        company: (card.querySelector(sel.company)?.textContent ?? "").replace(/\s+/g, " ").trim(),
        number: (card.querySelector(sel.number)?.textContent ?? "").replace(/\s+/g, "").trim(),
        href: card.querySelector(sel.open)?.getAttribute("href") ?? "",
      })),
    { statusActive: SEWOBE.results.statusActive, company: SEWOBE.results.company, number: SEWOBE.results.number, open: SEWOBE.results.open },
  );
}

export async function searchHits(page: Page, cfg: Config, vorname: string, nachname: string): Promise<Hit[]> {
  const step = "sewobe-search";
  const term = collapse(`${vorname} ${nachname}`);
  const input = page.locator(SEWOBE.search).first();
  await input.fill(term, { timeout: cfg.stepTimeoutMs });
  await input.press("Enter");
  await page.waitForTimeout(cfg.searchSettleMs);

  const frame = page.frameLocator(SEWOBE.frames.main).frameLocator(SEWOBE.frames.results);
  try {
    await frame.locator("body").filter({ hasText: `Suchbegriff: ${term}` }).waitFor({ state: "attached", timeout: cfg.searchTimeoutMs });
    await Promise.any([
      frame.locator(SEWOBE.results.card).first().waitFor({ state: "attached", timeout: cfg.searchTimeoutMs }),
      frame.locator(SEWOBE.results.empty).first().waitFor({ state: "attached", timeout: cfg.searchTimeoutMs }),
    ]);
  } catch (error) {
    if (isPlaywrightTimeout(error) || error instanceof AggregateError) {
      throw new BotError("TIMEOUT", "SEWOBE-Suche lieferte kein Ergebnis in der erwarteten Zeit", { step });
    }
    throw error;
  }
  return readHits(page);
}

export function selectHit(hits: Hit[], vorname: string, nachname: string, mitgliedsnummer: string | undefined): Selection {
  const wanted = normalizeName(`${nachname}, ${vorname}`);
  let exact = hits.filter((hit) => normalizeName(hit.company) === wanted);
  if (mitgliedsnummer !== undefined) exact = exact.filter((hit) => hit.number === mitgliedsnummer);

  if (exact.length === 0) {
    throw new BotError("SEWOBE_NO_MATCH", "Keine Person in SEWOBE mit genau diesem Vor- und Nachnamen gefunden", {
      step: "sewobe-search",
      details: [`Suchergebnisse insgesamt: ${hits.length}`],
    });
  }
  const active = exact.filter((hit) => hit.active);
  if (active.length === 0) return { kind: "inactive" };
  if (active.length > 1) {
    throw new BotError("SEWOBE_AMBIGUOUS", `Mehrere aktive Personen in SEWOBE mit diesem Namen (${active.length}), keine Zuordnung möglich`, {
      step: "sewobe-search",
    });
  }
  const only = active[0];
  if (!only) throw new BotError("SEWOBE_NO_MATCH", "Keine Person in SEWOBE gefunden", { step: "sewobe-search" });
  return { kind: "found", hit: only };
}
