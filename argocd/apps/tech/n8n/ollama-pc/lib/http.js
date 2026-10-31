'use strict';

const http = require('http');
const https = require('https');

class HttpError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function request(url, { method = 'GET', body, headers = {}, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = transport.request(
      target,
      {
        method,
        agent: false,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = raw;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (err) {
            parsed = raw;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new HttpError(`HTTP ${res.statusCode} von ${target.host}`, { code: 'HTTP_STATUS', status: res.statusCode, body: parsed }));
            return;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(new HttpError(err.message, { code: err.code || 'NETWORK' }));
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new HttpError(`Timeout nach ${Math.round(timeoutMs / 1000)} s`, { code: 'TIMEOUT' }));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof HttpError ? err : new HttpError(err.message, { code: err.code || 'NETWORK' }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request, HttpError };
