'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const { buildMagicPacket, parseMac, wake } = require('../lib/wake');
const { startServer, json } = require('./helpers');

test('Magic Packet: 6x 0xFF gefolgt von 16x MAC', () => {
  const packet = buildMagicPacket('aa:bb:cc:dd:ee:ff');
  assert.equal(packet.length, 102);
  assert.ok(packet.subarray(0, 6).every((b) => b === 0xff));
  for (let i = 0; i < 16; i += 1) {
    assert.equal(packet.subarray(6 + i * 6, 12 + i * 6).toString('hex'), 'aabbccddeeff');
  }
});

test('MAC-Schreibweisen und Fehler', () => {
  assert.equal(parseMac('AA-BB-CC-DD-EE-FF').toString('hex'), 'aabbccddeeff');
  assert.throws(() => parseMac('nope'), /Ungültige MAC/);
});

test('UDP-Wake sendet das Paket an Broadcast-Adresse und Port', async () => {
  const receiver = dgram.createSocket('udp4');
  const received = new Promise((resolve) => receiver.once('message', resolve));
  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve));
  const { port } = receiver.address();
  await wake({ mode: 'udp', mac: '98:fa:9b:28:b0:22', broadcast: '127.0.0.1', port });
  const packet = await received;
  receiver.close();
  assert.deepEqual(packet, buildMagicPacket('98:fa:9b:28:b0:22'));
});

test('HTTP-Wake ruft den Relay mit Bearer-Token und Ziel auf', async () => {
  const relay = await startServer((call, res) => json(res, 200, { status: 'ok' }));
  await wake({ mode: 'http', url: `${relay.url}/api/power/wake`, target: 'ollama-pc', token: 'secret', timeoutMs: 2000 });
  await relay.close();
  assert.equal(relay.calls[0].method, 'POST');
  assert.equal(relay.calls[0].headers.authorization, 'Bearer secret');
  assert.deepEqual(relay.calls[0].body, { target: 'ollama-pc' });
});

test('Wake-Modus none tut nichts, command und http prüfen ihre Parameter', async () => {
  assert.equal(await wake({ mode: 'none' }), 'none');
  await assert.rejects(wake({ mode: 'http', url: '' }), /OLLAMA_WAKE_URL/);
  await assert.rejects(wake({ mode: 'command', command: '' }), /OLLAMA_WAKE_COMMAND/);
  assert.equal(await wake({ mode: 'command', command: 'true', timeoutMs: 2000 }), 'command');
  await assert.rejects(wake({ mode: 'command', command: 'exit 3', timeoutMs: 2000 }), /Wake-Kommando fehlgeschlagen/);
});
