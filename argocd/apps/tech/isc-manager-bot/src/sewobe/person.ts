import type { FrameLocator, Page } from "playwright";
import type { Config } from "../config.js";
import { BotError } from "../errors.js";
import type { SewobePerson } from "../sync/types.js";
import { requireAttached } from "../pw.js";
import type { Hit } from "./search.js";
import { SEWOBE } from "./selectors.js";

async function selectedText(frame: FrameLocator, selector: string): Promise<string> {
  return frame
    .locator(selector)
    .first()
    .evaluate((el) => {
      const select = el as HTMLSelectElement;
      return select.options[select.selectedIndex]?.text ?? "";
    });
}

export async function readPerson(page: Page, cfg: Config, hit: Hit): Promise<SewobePerson> {
  const step = "sewobe-person";
  if (hit.href === "") throw new BotError("FORM_CHANGED", "Treffer in SEWOBE enthält keinen Link zur Personenseite", { step });
  const target = new URL(hit.href, page.url()).toString();
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: cfg.stepTimeoutMs });

  const frame = page.frameLocator(SEWOBE.frames.detail);
  const fields = SEWOBE.detail;
  await requireAttached(frame.locator(fields.vorname), cfg.stepTimeoutMs, "Personenformular in SEWOBE", step);

  const read = (selector: string): Promise<string> => frame.locator(selector).first().inputValue({ timeout: cfg.stepTimeoutMs });
  return {
    vorname: await read(fields.vorname),
    nachname: await read(fields.nachname),
    geburtstag: await read(fields.geburtstag),
    anrede: await selectedText(frame, fields.anrede),
    mitgliedsnummer: hit.number,
    strasse: await read(fields.strasse),
    plz: await read(fields.plz),
    ort: await read(fields.ort),
    land: await selectedText(frame, fields.land),
  };
}
