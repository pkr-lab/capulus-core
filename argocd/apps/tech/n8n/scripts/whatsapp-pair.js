// Einmalige Kopplung des n8n-Pods mit einem WhatsApp-Konto (Business-App:
// Einstellungen -> Verknuepfte Geraete) und Ermittlung der Ziel-ID fuer den
// Workflow email-to-whatsapp-kanal.json.
//
// Aufruf vom Rechner mit kubectl-Zugriff auf den TECH-Cluster (Skript per stdin):
//   kubectl -n n8n exec -i deploy/n8n -- node - < argocd/apps/tech/n8n/scripts/whatsapp-pair.js
// Optional den Kanal ueber seinen oeffentlichen Link aufloesen, falls er unten
// nicht aufgelistet wird (Teil nach https://whatsapp.com/channel/):
//   kubectl -n n8n exec -i deploy/n8n -- node - --invite=0029Vaxxxxxxxx < .../whatsapp-pair.js
//
// Ablauf: QR-Code erscheint im Terminal -> mit dem Handy scannen -> Skript listet
// Kanaele und Gruppen mit ihrer ID und beendet sich. Die Session landet auf dem
// n8n-PVC (/home/node/.n8n/whatsapp-session) und wird vom Workflow wiederverwendet.
// Vorher den Workflow deaktivieren (oder sicherstellen, dass keine Mail kommt):
// Chromium erlaubt das Profil nur einmal, das Skript nutzt dasselbe Lock wie der Workflow.
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');

const AUTH_DIR = '/home/node/.n8n/whatsapp-session';
const LOCK_DIR = AUTH_DIR + '.lock';
const CHROMIUM = '/usr/bin/chromium-browser';
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

const invite = (process.argv.find((a) => a.startsWith('--invite=')) || '').slice('--invite='.length);

try {
  fs.mkdirSync(LOCK_DIR);
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  console.error('Lock ' + LOCK_DIR + ' existiert: der Workflow sendet gerade oder ein frueherer Lauf wurde hart beendet.');
  console.error('Ist sicher, dass nichts laeuft, dann: kubectl -n n8n exec deploy/n8n -- rmdir ' + LOCK_DIR);
  process.exit(1);
}
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.rmSync(AUTH_DIR + '/session/' + f, { force: true }); } catch (e) { /* nicht vorhanden */ }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: {
    headless: true,
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run'],
  },
});

let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  try { await Promise.race([client.destroy(), new Promise((r) => setTimeout(r, 20000))]); } catch (e) { /* egal */ }
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (e) { /* egal */ }
  process.exit(code);
}

const timer = setTimeout(() => { console.error('Timeout: kein Scan innerhalb von 5 Minuten.'); finish(1); }, SCAN_TIMEOUT_MS);

client.on('qr', async (qr) => {
  console.log('\nQR-Code mit dem Handy scannen (WhatsApp -> Verknuepfte Geraete -> Geraet hinzufuegen):\n');
  console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
});
client.on('authenticated', () => console.log('Authentifiziert, warte auf WhatsApp Web ...'));
client.on('auth_failure', (m) => { console.error('Anmeldung fehlgeschlagen: ' + m); finish(1); });

client.on('ready', async () => {
  clearTimeout(timer);
  try {
    console.log('\nGekoppelt als ' + (client.info && client.info.pushname) + ' (' + (client.info && client.info.wid && client.info.wid.user) + ').');

    const channels = await client.getChannels();
    console.log('\nKanaele (Ziel-ID endet auf @newsletter):');
    for (const c of channels) console.log('  ' + c.id._serialized + '  ' + c.name + '  [posten: ' + (c.isReadOnly ? 'NEIN, nur lesen' : 'ja') + ']');
    if (!channels.length) console.log('  (keine)');

    if (invite) {
      const c = await client.getChannelByInviteCode(invite);
      console.log('\nKanal zu Einladungscode ' + invite + ':');
      console.log(c ? '  ' + c.id._serialized + '  ' + c.name + '  [posten: ' + (c.isReadOnly ? 'NEIN, nur lesen' : 'ja') + ']' : '  nicht gefunden');
    }

    const groups = (await client.getChats()).filter((c) => c.isGroup);
    console.log('\nGruppen (Ziel-ID endet auf @g.us):');
    for (const g of groups) console.log('  ' + g.id._serialized + '  ' + g.name);
    if (!groups.length) console.log('  (keine)');

    console.log('\nZiel-ID in n8n im Node "An WhatsApp senden" als TARGET_ID eintragen.');
    await finish(0);
  } catch (e) {
    console.error('Fehler beim Auflisten: ' + (e && e.message));
    await finish(1);
  }
});

client.initialize().catch((e) => { console.error('Start fehlgeschlagen: ' + (e && e.message)); finish(1); });
