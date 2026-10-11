import { ValidationError } from "./errors.js";

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMimeType = (typeof ALLOWED_IMAGE_TYPES)[number];

export type ImageInput = {
  fileName: string;
  mimeType: ImageMimeType;
  dataBase64: string;
  keywords: string[];
};

export type DecodedImage = {
  fileName: string;
  mimeType: ImageMimeType;
  buffer: Buffer;
  keywords: string[];
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URI_PREFIX = /^data:[^;,]+;base64,/;

function hasSignature(buffer: Buffer, mimeType: ImageMimeType): boolean {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP";
}

export function decodeImage(image: ImageInput, maxBytes: number, index: number): DecodedImage {
  const label = `Bild ${index + 1} (${image.fileName})`;
  const cleaned = image.dataBase64.replace(DATA_URI_PREFIX, "").replace(/\s+/g, "");
  if (cleaned.length === 0 || cleaned.length % 4 !== 0 || !BASE64.test(cleaned)) {
    throw new ValidationError(`${label}: dataBase64 ist kein gültiges Base64`, [`${label}: ungültiges Base64`]);
  }
  const buffer = Buffer.from(cleaned, "base64");
  if (buffer.toString("base64") !== cleaned) {
    throw new ValidationError(`${label}: dataBase64 ist kein gültiges Base64`, [`${label}: ungültiges Base64`]);
  }
  if (buffer.length > maxBytes) {
    throw new ValidationError(`${label}: größer als ${maxBytes} Bytes`, [`${label}: zu groß (${buffer.length} Bytes)`]);
  }
  if (!hasSignature(buffer, image.mimeType)) {
    throw new ValidationError(`${label}: Dateiinhalt passt nicht zu ${image.mimeType}`, [`${label}: Dateiinhalt passt nicht zu ${image.mimeType}`]);
  }
  return { fileName: image.fileName, mimeType: image.mimeType, buffer, keywords: image.keywords };
}
