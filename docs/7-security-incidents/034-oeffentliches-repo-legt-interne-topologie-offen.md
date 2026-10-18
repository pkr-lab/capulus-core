# 034 Das öffentliche Repo legt interne Topologie und Kontaktdaten offen

- Severity: Info
- Bereich: Repo
- Betroffen: 99 Dateien mit RFC1918-Adressen, 26 mit Tailnet-IPs, 6 mit MAC-Adressen, E-Mail-Adressen (`edv-kretzer.de`, `dlrg.org`, `gmail.com`), SIP-Ziel `sip:…@sip.linphone.org`, Cloudflare-Tunnel-ID
- Status: Akzeptiertes Risiko (Betreiber, 2026-10-18): Mail-Adressen und Heimnetz-Daten

## Beschreibung

Das Repository dokumentiert das Heimnetz vollständig: Host-IPs und Rollen (`192.168.178.94/.95/.96/.97/.98/.99/.100`), Tailnet-Adressen, MAC-Adressen der Worker (Wake-on-LAN), den Aufbau von Namespaces, Ingresses und Public-Hostnamen, die Tunnel-ID, Kontaktadressen von Betreiber und Organisation sowie das SIP-Ziel der Telefon-Alarmierung. Das ist für sich keine Schwachstelle, erleichtert Angreifern aber Aufklärung und gezielte Angriffe (Social Engineering auf die Bereitschaft, Netzwerkkarte für Post-Exploitation). Die Doku ist zugleich der betriebliche Wert dieses Repos.

## Nachweis

```
$ git grep -l -E '\b(192\.168\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+)\b' -- . ':!*.tgz' | wc -l
99
$ git grep -l -E '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+\b' -- . ':!*.tgz' | wc -l
26
$ git grep -l -E '\b([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b' -- . ':!*.tgz' | wc -l
6
```

## Risiko / Angriffsszenario

Kein direktes Risiko. Zusammen mit den Befunden 002, 004 und 005 (offene Dienste) erhält ein Angreifer eine vollständige Karte der Infrastruktur.

## Empfohlene Behebung

Akzeptieren oder die Infrastruktur-Details in ein privates Repo (oder in eine private Ebene) auslagern. Mindestens: keine neuen Klartext-Adressen von Endgeräten, Mobilfunk- oder Privat-E-Mail-Adressen, Telefon-/SIP-Ziele in SealedSecrets statt in `values.yaml`.

## Rollback

Nicht erforderlich.

## Verifikation

Entscheidung dokumentieren (Status `Akzeptiertes Risiko`) oder die Dateien aus dem öffentlichen Repo entfernen.

## Bearbeitung (2026-10-18)

**Geändert (Mindestmaß aus der Empfehlung).** Die private Gmail-Adresse des Betreibers stand als Beispiel in `docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md` (Cloudflare-Access-Policy). Sie ist durch eine Beschreibung ersetzt („die Adresse, mit der du dich bei Cloudflare anmeldest“).

**Geprüft, nicht geändert.** Die übrigen Kontaktangaben sind betrieblich gebunden: `info@edv-kretzer.de` (Funktions-Postfach, SMTP-Absender, Zammad-Agent), die erlaubte Absenderadresse des Instagram-Workflows in `300l0` (Dienstadresse), Platzhalter `sip:EINTRAGEN@sip.linphone.org` (das echte SIP-Ziel steht nicht im Repo, nur im Vault bzw. in der Rollenvariable). Sie zu entfernen würde die Doku unbrauchbar machen.

**Nicht entschieden (deine Wahl).** Die Empfehlung unterscheidet „akzeptieren“ und „Infrastruktur-Details in ein privates Repo auslagern“. Das Auslagern von 99 Dateien mit Heimnetz-Adressen widerspricht dem Zweck von `wiki-docs-sync` (das Repo wird nach Wiki.js gespiegelt) und ist nur mit einer neuen Trennung zwischen öffentlicher und privater Doku machbar. Mein Vorschlag, wenn du es bei „akzeptiert“ belässt: den Status auf „Akzeptiertes Risiko“ setzen und die Regel beibehalten, dass keine neuen privaten Adressen, Mobilnummern oder SIP-Ziele ins Repo kommen.

**Weiter vorhanden:** `argocd/apps/tech/n8n/workflows/PaperlessWorkflow.json` enthält im Code-Knoten die Liste `ADRESSEN` mit fünf privaten Gmail-Adressen (darunter dieselbe) und zwei Postfächern von `edv-kretzer.de`. Die Liste entscheidet, welche eingehenden Mails als „meine Adresse“ gelten; sie zu ändern ändert das Verhalten des Workflows. Besser wäre ein Parameter aus einem n8n-Credential oder einer Variable statt der Liste im Quelltext. Das ändere ich nicht ohne dich, weil der Workflow Dokumente nach Paperless übergibt. Auch die Git-Historie enthält die Adresse (vier Commits).

**Geänderte Dateien.** `docs/e-externe-erreichbarkeit/e0000-cloudflare-tunnel.md`

**Rollback.** Nicht erforderlich.

## Entscheidung des Betreibers (2026-10-18)

Die Mail-Adressen (Funktionspostfach `info@edv-kretzer.de`, Dienstadressen, die Liste in `PaperlessWorkflow.json`) sind **akzeptiert**. Zu den „Heimnetz-Daten“ aus dem Befund: gemeint sind die internen IP-Adressen (`192.168.178.94`, `.95`, `.96`, `.97`, `.98`, `.99`, `.100`), die Tailscale-Adressen der Geräte (`100.x.x.x`), die MAC-Adressen der Worker für Wake-on-LAN (in `host_vars/worker-*/vars.yml`), die Cloudflare-Tunnel-ID, interne Hostnamen (`*.homeserver`) und die Namespaces/Ingresses in den Charts. Sie stehen in über 100 Dateien, vor allem in `ansible/` und `docs/`. Allein nützen sie einem Angreifer nichts, sie erleichtern aber die Aufklärung, wenn ein Zugang schon besteht. Auslagern in ein privates Repo hieße, Inventar und Doku zu trennen (und die Spiegelung nach Wiki.js zu ändern); die pragmatische Linie wäre, sie als akzeptiert zu verbuchen und nur neue private Telefonnummern und Mobil-Mailadressen draußen zu halten. Auf dein Wort setze ich den Status dann auf „Akzeptiertes Risiko“.

## Entscheidung des Betreibers (2026-10-18)

Auch die Heimnetz-Daten (interne und Tailscale-IP-Adressen, MAC-Adressen für Wake-on-LAN, Tunnel-ID, interne Hostnamen) sind **akzeptiertes Risiko**. Die Regel bleibt: keine neuen privaten Telefonnummern, Mobil-Mailadressen oder SIP-Ziele ins Repo.
