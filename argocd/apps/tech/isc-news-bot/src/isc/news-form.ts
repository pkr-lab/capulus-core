import type { Page } from "playwright";
import type { Config } from "../config.js";
import { IscBotError, ValidationError } from "../errors.js";
import type { ParsedNews } from "../validation.js";
import { TYPE_VALUE, SEL, createUrl } from "./selectors.js";
import { fillField, requireAttached, requireVisible, selectOptionValue } from "./helpers.js";
import type { CategoryOption } from "../categories.js";

export function normalizeHtml(value: string): string {
  return value.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
}

export async function openCreateForm(page: Page, cfg: Config, step = "form"): Promise<void> {
  await page.goto(createUrl(cfg.iscBaseUrl), { waitUntil: "domcontentloaded" });
  await requireAttached(page.locator(SEL.news.form), cfg.stepTimeoutMs, SEL.news.form, step);
  await requireVisible(page.locator(SEL.news.title), cfg.stepTimeoutMs, SEL.news.title, step);
}

export async function readCategoryOptions(page: Page, cfg: Config, step = "form"): Promise<CategoryOption[]> {
  const select = page.locator(SEL.news.categories);
  await requireAttached(select, cfg.stepTimeoutMs, SEL.news.categories, step);
  const options = await select.first().locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: (node as HTMLOptionElement).value,
      name: (node.textContent ?? "").trim(),
    })),
  );
  return options.filter((option) => option.value !== "");
}

async function setType(page: Page, news: ParsedNews, cfg: Config, step: string): Promise<void> {
  const value = TYPE_VALUE[news.type];
  await selectOptionValue(page, SEL.news.type, value, cfg.stepTimeoutMs, step);
  const block = SEL.typeBlocks[Number(value)];
  if (!block) throw new IscBotError("INTERNAL", `Kein Typ-Block für Typ ${news.type}`, { step });
  await requireVisible(page.locator(block), cfg.stepTimeoutMs, block, step);
}

export async function setCategories(page: Page, values: string[], step: string): Promise<void> {
  if (values.length === 0) return;
  const result = await page.evaluate(
    ([selector, wanted]: [string, string[]]) => {
      const jq = (window as unknown as { jQuery?: any }).jQuery;
      if (!jq) return { ok: false, selected: [] as string[], reason: "jQuery fehlt" };
      const field = jq(selector);
      if (!field.length || typeof field.selectpicker !== "function") {
        return { ok: false, selected: [] as string[], reason: "selectpicker fehlt" };
      }
      field.selectpicker("val", wanted);
      field.trigger("change");
      const selected = (field.val() ?? []) as string[];
      return { ok: true, selected: [...selected], reason: "" };
    },
    [SEL.news.categories, values] as [string, string[]],
  );
  const got = [...result.selected].sort();
  const want = [...values].sort();
  const same = got.length === want.length && got.every((v, i) => v === want[i]);
  if (!result.ok || !same) {
    throw new IscBotError("FORM_CHANGED", `Kategorien nicht übernommen (${result.reason || got.join(",")})`, { step });
  }
}

export async function setEditorText(page: Page, html: string, step: string): Promise<void> {
  const result = await page.evaluate(
    ([text, ck4Name, ck5Selector, textareaSelector]: [string, string, string, string]) => {
      const w = window as unknown as { CKEDITOR?: { instances?: Record<string, any> } };
      const ck4 = w.CKEDITOR?.instances?.[ck4Name];
      if (ck4) {
        ck4.setData(text);
        return { engine: "ckeditor4", value: String(ck4.getData()) };
      }
      const editable = document.querySelector(ck5Selector) as (HTMLElement & { ckeditorInstance?: any }) | null;
      if (editable) {
        const ck5 = editable.ckeditorInstance;
        if (!ck5) return { engine: "ckeditor5-ohne-instanz", value: "" };
        ck5.setData(text);
        return { engine: "ckeditor5", value: String(ck5.getData()) };
      }
      const area = document.querySelector(textareaSelector) as HTMLTextAreaElement | null;
      if (!area) return { engine: "textfeld-fehlt", value: "" };
      if (area.hasAttribute("data-ckeditor-config")) return { engine: "ckeditor-ohne-instanz", value: "" };
      area.value = text;
      area.dispatchEvent(new Event("change", { bubbles: true }));
      return { engine: "textarea", value: area.value };
    },
    [html, SEL.ckeditor4Instance, SEL.ckeditor5Editable, SEL.news.text] as [string, string, string, string],
  );
  if (result.engine === "textfeld-fehlt" || result.engine.endsWith("ohne-instanz")) {
    throw new IscBotError("FORM_CHANGED", `Textfeld nicht nutzbar (${result.engine})`, { step });
  }
  if (normalizeHtml(result.value) !== normalizeHtml(html)) {
    throw new IscBotError("FORM_CHANGED", `Editor (${result.engine}) hat den Text nicht übernommen`, { step });
  }
}

export async function validateWithParsley(page: Page): Promise<void> {
  const result = await page.evaluate((formSelector: string) => {
    const jq = (window as unknown as { jQuery?: any }).jQuery;
    let valid = true;
    if (jq && jq.fn && typeof jq.fn.parsley === "function") {
      valid = jq(formSelector).parsley().validate() !== false;
    }
    const messages = Array.from(document.querySelectorAll(".parsley-errors-list li"))
      .map((li) => (li.textContent ?? "").trim())
      .filter((text) => text.length > 0);
    return { valid, messages };
  }, SEL.news.form);
  if (!result.valid || result.messages.length > 0) {
    const details = result.messages.length > 0 ? result.messages : ["Client-Validierung (Parsley) fehlgeschlagen"];
    throw new ValidationError("Formular-Validierung im ISC fehlgeschlagen", details);
  }
}

export async function fillNewsForm(page: Page, news: ParsedNews, categoryValues: string[], cfg: Config, step = "form"): Promise<void> {
  const timeout = cfg.stepTimeoutMs;
  await setType(page, news, cfg, step);
  await fillField(page, SEL.news.title, news.title, timeout, step);
  await fillField(page, SEL.news.subtitle, news.subtitle, timeout, step);
  if (news.type === "link") {
    await fillField(page, SEL.news.link, news.link, timeout, step);
  }
  if (news.type === "typo3" && news.typo3Id !== undefined) {
    await fillField(page, SEL.news.typo3Id, String(news.typo3Id), timeout, step);
  }
  await fillField(page, SEL.news.startDate, news.startDate, timeout, step);
  await fillField(page, SEL.news.archiveDate, news.archiveDate ?? "", timeout, step);
  await fillField(page, SEL.news.endDate, news.endDate ?? "", timeout, step);
  await setCategories(page, categoryValues, step);
  if (news.html !== "") {
    await setEditorText(page, news.html, step);
  }
  await fillField(page, SEL.news.author, news.author, timeout, step);
  await fillField(page, SEL.news.authorEmail, news.authorEmail, timeout, step);
  await validateWithParsley(page);
}
