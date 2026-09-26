// Einmalige Kopplung des n8n-Pods mit einem WhatsApp-Konto (Business-App:
// Einstellungen -> Verknuepfte Geraete) und Ermittlung der Kanal-ID fuer den
// Workflow email-to-whatsapp-kanal.json. Der Workflow sendet ausschliesslich in
// Kanaele, deshalb werden nur Kanaele aufgelistet.
//
// Aufruf vom Rechner mit kubectl-Zugriff auf den TECH-Cluster (Skript per stdin):
//   kubectl -n n8n exec -i deploy/n8n -- node - < argocd/apps/tech/n8n/scripts/whatsapp-pair.js
// Optional den Kanal ueber seinen oeffentlichen Link aufloesen, falls er unten
// nicht aufgelistet wird (Teil nach https://whatsapp.com/channel/):
//   kubectl -n n8n exec -i deploy/n8n -- node - --invite=0029Vaxxxxxxxx < .../whatsapp-pair.js
//
// Ablauf: QR-Code erscheint im Terminal -> mit dem Handy scannen -> Skript listet
// die Kanaele mit ihrer ID und beendet sich. Die Session landet auf dem
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Aus WhatsApp Web kommen teils minifizierte Fehler (Message z. B. nur "r") -> mit Stack ausgeben.
const errText = (e) => String((e && (e.stack || e.message)) || e).split('\n').slice(0, 3).join(' | ');

// client.getChannels()/getChats() holen pro Eintrag Metadaten nach und scheitern
// als Ganzes, sobald ein Eintrag Probleme macht. Fuer die Auflistung reicht ein
// direkter Blick in die (lokalen) WhatsApp-Web-Sammlungen.
const listChannels = () => client.pupPage.evaluate(() => {
  const col = window.require('WAWebCollections').WAWebNewsletterCollection;
  return (col ? col.getModelsArray() : []).map((c) => {
    const md = c.newsletterMetadata || {};
    return {
      id: c.id && c.id._serialized,
      name: c.name || c.formattedTitle || md.name || (md.titleMetadata && md.titleMetadata.title) || '',
      role: md.membershipType || null,
    };
  });
});

client.on('ready', async () => {
  clearTimeout(timer);
  console.log('\nGekoppelt als ' + (client.info && client.info.pushname) + ' (' + (client.info && client.info.wid && client.info.wid.user) + ').');
  let failed = false;

  // Die Kanalliste ist direkt nach "ready" oft noch leer und fuellt sich erst nach einigen Sekunden.
  console.log('\nKanaele (Ziel-ID endet auf @newsletter), warte bis zu 45 s auf die Liste ...');
  try {
    let channels = [];
    for (const end = Date.now() + 45000; ;) {
      channels = await listChannels();
      if (channels.length || Date.now() > end) break;
      await sleep(3000);
    }
    for (const c of channels) console.log('  ' + c.id + '  ' + c.name + '  [Rolle: ' + (c.role || 'unbekannt') + ']');
    if (!channels.length) console.log('  (keine) -> Kanal per Einladungslink aufloesen: --invite=<Code hinter whatsapp.com/channel/>');
  } catch (e) { failed = true; console.error('  Kanalliste fehlgeschlagen: ' + errText(e)); }

  if (invite) {
    console.log('\nKanal zu Einladungscode ' + invite + ':');
    try {
      // Nur die Metadaten-Abfrage (liefert die ID); client.getChannelByInviteCode() laedt danach noch den ganzen Chat.
      const md = await client.pupPage.evaluate((code) => window.WWebJS.getChannelMetadata(code), invite);
      console.log('  ' + ((md.id && md.id._serialized) || md.id) + '  ' + (md.titleMetadata && md.titleMetadata.title));
    } catch (e) { failed = true; console.error('  Aufloesen fehlgeschlagen: ' + errText(e)); }
  }

  console.log('\nKanal-ID in n8n im Node "An WhatsApp senden" als TARGET_ID eintragen.');
  await finish(failed ? 1 : 0);
});

client.initialize().catch((e) => { console.error('Start fehlgeschlagen: ' + (e && e.message)); finish(1); });
