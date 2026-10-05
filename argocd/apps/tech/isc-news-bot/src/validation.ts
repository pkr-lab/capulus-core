import type { Config, Mode } from "./config.js";
import { ValidationError } from "./errors.js";
import { toIscLocal, formatBerlinLocal } from "./datetime.js";
import { decodeImage, ALLOWED_IMAGE_TYPES, type DecodedImage, type ImageMimeType } from "./images.js";

export const TYPE_BY_NAME = { text: "0", link: "1", typo3: "2" } as const;
export type NewsType = keyof typeof TYPE_BY_NAME;

export type ParsedNews = {
  title: string;
  subtitle: string;
  html: string;
  type: NewsType;
  link: string;
  typo3Id: number | undefined;
  categories: string[];
  startDate: string;
  archiveDate: string | undefined;
  endDate: string | undefined;
  author: string;
  authorEmail: string;
  mode: Mode;
  images: DecodedImage[];
  disallowResizeImage: boolean;
  firstAssetOnlyTeaser: boolean;
  force: boolean;
  dryRun: boolean;
};

const MAX_TITLE = 255;
const MAX_SUBTITLE = 2000;
const MAX_HTML = 200_000;
const MAX_IMAGES = 20;
const MAX_KEYWORDS = 10;
const MAX_KEYWORD_LENGTH = 50;
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,118}\.(jpe?g|png|webp)$/i;
const HTTP_URL = /^https?:\/\/\S+$/;

type Body = Record<string, unknown>;

function isPlainObject(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(body: Body, key: string, errors: string[], max: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    errors.push(`${key} muss ein Text sein`);
    return undefined;
  }
  if (value.length > max) {
    errors.push(`${key} ist länger als ${max} Zeichen`);
    return undefined;
  }
  return value;
}

function optionalBoolean(body: Body, key: string, errors: string[]): boolean {
  const value = body[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    errors.push(`${key} muss true oder false sein`);
    return false;
  }
  return value;
}

function parseDate(body: Body, key: string, errors: string[]): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    errors.push(`${key} muss ein Datum im Format YYYY-MM-DDTHH:mm sein`);
    return undefined;
  }
  const local = toIscLocal(value.trim());
  if (!local) {
    errors.push(`${key} ist kein gültiges Datum: ${value}`);
    return undefined;
  }
  return local;
}

function parseCategories(body: Body, errors: string[]): string[] {
  const value = body.categories;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push("categories muss eine Liste sein");
    return [];
  }
  if (value.length > 20) {
    errors.push("categories enthält mehr als 20 Einträge");
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isInteger(entry) && entry > 0) {
      result.push(String(entry));
    } else if (typeof entry === "string" && entry.trim() !== "" && entry.length <= 100) {
      result.push(entry.trim());
    } else {
      errors.push(`ungültiger Kategorie-Eintrag: ${JSON.stringify(entry)}`);
    }
  }
  return result;
}

function parseKeywords(raw: unknown, fallback: string[], label: string, errors: string[]): string[] {
  if (raw === undefined || raw === null) return fallback;
  if (!Array.isArray(raw) || raw.length > MAX_KEYWORDS) {
    errors.push(`${label}: keywords muss eine Liste mit höchstens ${MAX_KEYWORDS} Einträgen sein`);
    return fallback;
  }
  const keywords: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "" || entry.trim().length > MAX_KEYWORD_LENGTH) {
      errors.push(`${label}: ungültiges Schlagwort`);
      continue;
    }
    keywords.push(entry.trim());
  }
  return keywords;
}

function parseImages(raw: unknown, config: Config, errors: string[]): DecodedImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) {
    errors.push(`images muss eine Liste mit höchstens ${MAX_IMAGES} Bildern sein`);
    return [];
  }
  const decoded: DecodedImage[] = [];
  raw.forEach((entry, index) => {
    const label = `Bild ${index + 1}`;
    if (!isPlainObject(entry)) {
      errors.push(`${label}: muss ein Objekt sein`);
      return;
    }
    const fileName = entry.fileName;
    const mimeType = entry.mimeType;
    const dataBase64 = entry.dataBase64;
    if (typeof fileName !== "string" || !FILE_NAME.test(fileName)) {
      errors.push(`${label}: fileName muss ein einfacher Dateiname mit .jpg, .png oder .webp sein`);
      return;
    }
    if (typeof mimeType !== "string" || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mimeType)) {
      errors.push(`${label}: mimeType muss ${ALLOWED_IMAGE_TYPES.join(", ")} sein`);
      return;
    }
    if (typeof dataBase64 !== "string") {
      errors.push(`${label}: dataBase64 fehlt`);
      return;
    }
    const keywords = parseKeywords(entry.keywords, config.defaultImageKeywords, label, errors);
    try {
      decoded.push(
        decodeImage(
          { fileName, mimeType: mimeType as ImageMimeType, dataBase64, keywords },
          config.maxImageBytes,
          index,
        ),
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        errors.push(...error.details);
        return;
      }
      throw error;
    }
  });
  return decoded;
}

export function validateNewsRequest(body: unknown, config: Config, now: Date = new Date()): ParsedNews {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request-Body muss ein JSON-Objekt sein");
  }
  const errors: string[] = [];

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title === "") errors.push("title fehlt");
  if (title.length > MAX_TITLE) errors.push(`title ist länger als ${MAX_TITLE} Zeichen`);

  const subtitle = optionalString(body, "subtitle", errors, MAX_SUBTITLE)?.trim() ?? "";
  const html = optionalString(body, "html", errors, MAX_HTML)?.trim() ?? "";

  const typeRaw = body.type ?? "text";
  const type = typeof typeRaw === "string" && Object.hasOwn(TYPE_BY_NAME, typeRaw) ? (typeRaw as NewsType) : undefined;
  if (!type) errors.push('type muss "text", "link" oder "typo3" sein');

  let link = "";
  let typo3Id: number | undefined;
  if (type === "text" && html === "") errors.push("html (Text) fehlt: bei type=text ist ein Text Pflicht");
  if (type === "link") {
    const value = typeof body.link === "string" ? body.link.trim() : "";
    if (!HTTP_URL.test(value)) errors.push("link muss eine http(s)-URL sein, wenn type=link");
    link = value;
  }
  if (type === "typo3") {
    const value = body.typo3Id;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      typo3Id = value;
    } else {
      errors.push("typo3Id muss eine positive ganze Zahl sein, wenn type=typo3");
    }
  }

  const categories = parseCategories(body, errors);

  const startDate = parseDate(body, "startDate", errors);
  const archiveDate = parseDate(body, "archiveDate", errors);
  const endDate = parseDate(body, "endDate", errors);
  const effectiveStart = startDate ?? formatBerlinLocal(now);
  if (archiveDate && archiveDate < effectiveStart) errors.push("archiveDate liegt vor startDate");
  if (endDate && endDate < effectiveStart) errors.push("endDate liegt vor startDate");

  const author = optionalString(body, "author", errors, 100)?.trim() || config.defaultAuthor;
  const authorEmail = optionalString(body, "authorEmail", errors, 254)?.trim() || config.defaultAuthorEmail;
  if (!EMAIL.test(authorEmail)) errors.push("authorEmail ist keine gültige Adresse (ohne Umlaute und ß)");

  const modeRaw = body.mode ?? config.defaultMode;
  const mode: Mode | undefined = modeRaw === "draft" || modeRaw === "publish" ? modeRaw : undefined;
  if (!mode) errors.push('mode muss "draft" oder "publish" sein');

  const images = parseImages(body.images, config, errors);

  const disallowResizeImage = optionalBoolean(body, "disallowResizeImage", errors);
  const firstAssetOnlyTeaser = optionalBoolean(body, "firstAssetOnlyTeaser", errors);
  const force = optionalBoolean(body, "force", errors);
  const dryRun = optionalBoolean(body, "dryRun", errors);

  if (errors.length > 0) {
    throw new ValidationError(errors[0] ?? "Ungültige Eingabe", errors);
  }

  return {
    title,
    subtitle,
    html,
    type: type as NewsType,
    link,
    typo3Id,
    categories,
    startDate: effectiveStart,
    archiveDate,
    endDate,
    author,
    authorEmail,
    mode: mode as Mode,
    images,
    disallowResizeImage,
    firstAssetOnlyTeaser,
    force,
    dryRun,
  };
}
