import { existsSync } from "node:fs";
import http from "node:http";
import type { Config } from "./config.js";
import { isAuthorized } from "./auth.js";
import { IscBotError, HTTP_STATUS_BY_CODE, ValidationError } from "./errors.js";
import { logger as defaultLogger, type Logger } from "./logger.js";
import type { NewsResult, CategoriesResult } from "./runner.js";
import { validateNewsRequest } from "./validation.js";

export type NewsApi = {
  createNews(news: ReturnType<typeof validateNewsRequest>): Promise<NewsResult>;
  listCategories(): Promise<CategoriesResult>;
};

export type ServerDeps = {
  cfg: Config;
  runner: NewsApi;
  logger?: Logger;
  browserReady?: () => boolean;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, `Request-Body größer als ${maxBytes} Bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(deps: ServerDeps): http.Server {
  const log = deps.logger ?? defaultLogger;
  const { cfg, runner } = deps;
  const browserReady = deps.browserReady ?? (() => true);

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    res.on("finish", () => {
      log.info("http", { method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - started });
    });

    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        const ready = browserReady();
        return sendJson(res, ready ? 200 : 503, { ok: ready });
      }
      if (!isAuthorized(req.headers.authorization, cfg.apiToken)) {
        req.resume();
        return sendJson(res, 401, { ok: false, error: "Nicht autorisiert" });
      }
      if (req.method === "GET" && url.pathname === "/categories") {
        const result = await runner.listCategories();
        if (result.ok) return sendJson(res, 200, result);
        return sendJson(res, HTTP_STATUS_BY_CODE[result.errorCode], result);
      }
      if (req.method === "POST" && url.pathname === "/news") {
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.startsWith("application/json")) {
          req.resume();
          return sendJson(res, 415, { ok: false, errorCode: "VALIDATION_FAILED", error: "Content-Type muss application/json sein" });
        }
        const raw = await readBody(req, cfg.maxBodyBytes);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { ok: false, errorCode: "VALIDATION_FAILED", error: "Body ist kein gültiges JSON" });
        }
        const news = validateNewsRequest(parsed, cfg);
        const result = await runner.createNews(news);
        if (result.ok) return sendJson(res, 200, result);
        return sendJson(res, result.errorCode ? HTTP_STATUS_BY_CODE[result.errorCode] : 500, result);
      }
      req.resume();
      return sendJson(res, 404, { ok: false, error: "Nicht gefunden" });
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(res, error.status, { ok: false, errorCode: "VALIDATION_FAILED", error: error.message });
      }
      if (error instanceof ValidationError) {
        return sendJson(res, 400, { ok: false, errorCode: error.code, error: error.message, details: error.details });
      }
      if (error instanceof IscBotError && error.code === "BUSY") {
        return sendJson(res, 429, { ok: false, errorCode: error.code, error: error.message }, { "Retry-After": "60" });
      }
      log.error("Unerwarteter Fehler", { path: url.pathname, message: error instanceof Error ? error.message : "unbekannt" });
      return sendJson(res, 500, { ok: false, errorCode: "INTERNAL", error: "Interner Fehler" });
    }
  });
}

export function chromiumInstalled(executablePath: string): boolean {
  return existsSync(executablePath);
}
