'use strict';

const http = require('http');
const path = require('path');
const { loadConfig } = require('../lib/config');

function startServer(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
        calls.push(call);
        handler(call, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function testConfig(overrides = {}) {
  const config = loadConfig({
    OLLAMA_URL: 'http://127.0.0.1:1',
    OLLAMA_PROMPTS_DIR: path.join(__dirname, 'fixtures'),
    OLLAMA_KNOWLEDGE_DIR: path.join(__dirname, 'fixtures', 'knowledge'),
    OLLAMA_HEALTH_TIMEOUT_SECONDS: '1',
  });
  return { ...config, ...overrides, wake: { ...config.wake, ...(overrides.wake || {}) } };
}

module.exports = { startServer, json, testConfig };
