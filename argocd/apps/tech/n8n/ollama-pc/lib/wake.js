'use strict';

const dgram = require('dgram');
const { exec } = require('child_process');
const { request } = require('./http');

function parseMac(mac) {
  const hex = String(mac || '').replace(/[:\-.]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) {
    throw new Error(`Ungültige MAC-Adresse "${mac}"`);
  }
  return Buffer.from(hex, 'hex');
}

function buildMagicPacket(mac) {
  const macBytes = parseMac(mac);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => macBytes)]);
}

function sendMagicPacket({ mac, broadcast, port }) {
  const packet = buildMagicPacket(mac);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function runCommand(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Wake-Kommando fehlgeschlagen: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}

async function wake(wakeConfig) {
  switch (wakeConfig.mode) {
    case 'none':
      return 'none';
    case 'udp':
      await sendMagicPacket(wakeConfig);
      return 'udp';
    case 'http': {
      if (!wakeConfig.url) throw new Error('OLLAMA_WAKE_URL fehlt für OLLAMA_WAKE_MODE=http');
      await request(wakeConfig.url, {
        method: 'POST',
        body: { target: wakeConfig.target },
        headers: wakeConfig.token ? { Authorization: `Bearer ${wakeConfig.token}` } : {},
        timeoutMs: wakeConfig.timeoutMs,
      });
      return 'http';
    }
    case 'command':
      if (!wakeConfig.command) throw new Error('OLLAMA_WAKE_COMMAND fehlt für OLLAMA_WAKE_MODE=command');
      await runCommand(wakeConfig.command, wakeConfig.timeoutMs);
      return 'command';
    default:
      throw new Error(`Unbekannter Wake-Modus ${wakeConfig.mode}`);
  }
}

module.exports = { wake, buildMagicPacket, sendMagicPacket, parseMac };
