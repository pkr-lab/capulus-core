# carplay-api und iOS-App — Hintergründe

Begründungen zum Go-Backend `argocd/apps/tech/carplay-api/` und zur SwiftUI-App unter `ios/`. Bedienung, Einrichtung und Konfiguration:
[300d0](../3-apps-workloads/300d0-carplay-api.md) und [ios/README](../../ios/README.md) (dort auch der Abschnitt zum Transport HTTP/HTTPS).
Der Verzeichnisname `carplay-api` ist historisch (aus der CarPlay-Vorversion), das Backend bedient heute die reine iOS-App „Homeserver Dashboard“.
Übersicht dieser Kategorie: [60000](60000-uebersicht.md).

---

## carplay-api

### Aufbau und Verträge

- **Kleine, read-only Aggregations-API.** Sie kombiniert VictoriaMetrics, ntfy und Uptime Kuma zu **einem** Payload (`GET /api/dashboard`), den die App alle 30 Sekunden pollt. Feldnamen und
  JSON-Tags sind der **Vertrag mit dem iOS-Client**, eine Änderung ist ein Breaking Change. Die Swift-Modelle spiegeln die Go-Modelle (`models.*`) 1:1 und müssen im Gleichschritt bleiben.
- **Degradieren statt abstürzen.** Jeder Client ist timeout-begrenzt und liefert bei „Upstream down“ keinen harten Fehler, sondern einen Null-/Leerwert plus Warn-Log. Eine wacklige
  Abhängigkeit reißt so nie das ganze Dashboard mit. Konkret: Fehlt für einen Host eine Metrik, ist der Wert 0. Fehlt seine `up`-Serie oder ist `up=0`, kommt `Online=false` und jede Metrik auf 0, und
  die App blendet die Karte aus, statt „0 %“ zu zeigen. Scheitert die Service-Abfrage, stehen alle Services auf 0 Requests/s. Zusätzlich gibt es ein äußeres Zeitbudget über alle drei Upstreams
  (`overallTimeout`).
- **Ein-Wert-TTL-Cache:** Das Dashboard ist teuer (drei Upstream-Calls), ändert sich aber langsam. Ein gecachter Wert, den alle Requests teilen, genügt, ein Key-Store ist unnötig.
- **Keine `client-go`-Abhängigkeit.** Das Binary hat sonst null Kubernetes-API-Fläche. Für die Update-ConfigMap nutzt es minimal die In-Cluster-API mit dem ServiceAccount-Token des Pods, wie
  auch der Python-Watcher des github-release-watcher. Läuft es nicht im Cluster (z. B. `go run` lokal), gilt das Feature als „nicht verfügbar“: `GET /api/updates` liefert eine leere Liste statt
  den Start abzubrechen.
- **`/health` antwortet immer mit 200**, solange der Go-Prozess HTTP bedienen kann. Bei einem Replica würde ein fehlschlagender Liveness-/Readiness-Check wegen eines vorübergehend nicht erreichbaren
  Upstreams (ntfy, Uptime Kuma, …) nur einen völlig gesunden Pod neu starten oder aus dem Routing nehmen. Der Zustand je Abhängigkeit steht stattdessen im Body.
- **`/metrics` ist handgeschrieben** (vier Zähler im Prometheus-Textformat) statt `client_golang`: ein Overkill für einen so kleinen Dienst, und so bleiben Dependency-Baum, Image-Größe und `go.sum` klein.
  Als Label dient die **Route**, nicht der rohe Pfad, um unbegrenzte Label-Kardinalität durch unbekannte Pfade zu vermeiden.
- **Logging:** Je Request eine strukturierte JSON-Zeile (Methode, Pfad, Status, Dauer, Trace-ID), **bewusst ohne Header und Query-Strings**. Das Bearer-Token und andere sensible Werte dürfen nie
  in Logs landen.
- **Konfigurationsformate:** `HOSTS` = `id|name|instance,…`, `SERVICES` = `id|name|match,…`. Fehlerhafte Einträge werden still übersprungen, statt den Start wegen eines Tippfehlers im Helm-Wert
  zu verhindern. Die Default-Service-Liste spiegelt die Kurzlink-Kacheln der App (`Constants.SelfHostedServices`).
- Der Server schreibt nichts auf sein Root-FS (Konfiguration komplett aus Env-Vars), `readOnlyRootFilesystem` ist deshalb unproblematisch. Autoscaling bringt nichts: Ein einzelner App-Client pollt alle 30 s,
  ein HPA würde nur die Upstream-Last (VictoriaMetrics/ntfy/Uptime Kuma) vervielfachen. Die Struktur bleibt für den Bedarfsfall stehen.

### Absicherung

- **Kein mTLS, sondern zwei unabhängige Schichten.** Die ursprüngliche Spezifikation verlangte mTLS, aber der Traefik-Ingress dieses Clusters terminiert keine Client-Zertifikat-TLS, „mTLS“ wäre ein Häkchen
  ohne Substanz gewesen. Die echte Grenze ist die Netzwerkebene (Tailscale-only-Ingress, [300d0](../3-apps-workloads/300d0-carplay-api.md)) plus ein Bearer-Token auf Anwendungsebene.
- **`BearerAuth`** akzeptiert nur exakt `Bearer <token>` und vergleicht in **konstanter Zeit**, damit sich das Token nicht per Antwortzeit Byte für Byte erraten lässt.
- **`IPAllowlist`** ist die eigentliche Regel „nur unser Netz erreicht das“. Ungültige CIDR-Angaben führen zu einem **Panic beim Start**, statt still ignoriert zu werden: Ein Tippfehler würde die API sonst
  unbemerkt für die ganze Welt öffnen. Die Allowlist ist im Default **aus**, damit der erste Deploy nicht alle aussperrt, falls `trustedProxies` noch nicht stimmt (erst nach dem Abschnitt „Absicherung“ in 300d0
  scharf schalten). `trustedProxies` sind die CIDRs der Proxies, denen `X-Forwarded-For` geglaubt wird. Sie sind nötig, damit Allowlist und Access-Log die echte Client-IP hinter Traefik sehen und nicht die
  Pod-IP von Traefik (Pod-CIDR mit `kubectl -n kube-system get pods -o wide` bzw. den Traefik-Chart-Werten ermitteln). Als Bereiche dienen der Tailscale-CGNAT-Bereich und das LAN-Subnetz
  ([c0010](../c-netzwerk-dns/c0010-tailscale.md)).
- **CORS** erlaubt nur die konfigurierten Origins statt gins offenem Default. Non-Browser-Clients wie die `URLSession` der App ignorieren CORS ganz, es zählt also nur für ein hypothetisches Web-Frontend.
  Leer heißt: Es wird nie ein `Access-Control-Allow-Origin`-Header gesetzt.
- **`RateLimiter`:** Fixed-Window (pro Kalenderminute, nicht gleitend), Schlüssel ist die Client-IP, Antwort 429. Das reicht, weil die API hinter Tailscale für eine Handvoll Clients läuft und der Limiter nur
  ein Sicherheitsnetz gegen einen Client ist, der den Endpunkt hämmert. Ein Hintergrund-Sweep entfernt veraltete Einträge, damit die Map nicht unbegrenzt wächst.
- **Secrets:** `CARPLAY_API_TOKEN` ist `enabled: true` im Default, das Secret **muss vor dem ersten Sync versiegelt sein**, sonst bleibt der Pod in `CreateContainerConfigError` hängen. Das ist Absicht: Ein Dashboard,
  das Systemzustand und Alerts zeigt, soll nicht ungeschützt starten. Erzeugen: `openssl rand -hex 32`, dann
  `echo -n "<token>" | kubeseal --raw --namespace carplay-api --name carplay-api-token --cert ~/homelab-certs/sealed-secrets.pem --from-file=/dev/stdin` (oder über `kubeseal-webgui.tech.homeserver`).
  - **`POWER_AGENT_TOKEN`** ist ein **eigenes** Bearer-Token für den power-agent auf dem Host. Es muss mit `power_agent_token` in `/etc/power-agent/config.env` übereinstimmen (beide aus demselben
    `openssl rand -hex 32`). Fehlt das Secret, schlagen Helligkeit/Wake/Shutdown mit 502 fehl, der Rest der App bleibt nutzbar. Es ist bewusst nicht `CARPLAY_API_TOKEN`: Das App-Token soll allein nicht
    genügen, um etwas auszuschalten.
  - **`SHUTDOWN_CONFIRMATION_CODE`** ist der Code, den die App vor einem Homeserver-Shutdown abfragt. Es gibt **bewusst keinen Live-Check gegen ArgoCD** (dafür wären RBAC und ein Netzwerkpfad von diesem Pod aus
    nötig). Stattdessen wird er **manuell auf denselben Wert wie das aktuelle ArgoCD-Admin-Passwort** gesetzt ([b0010](../b-kubernetes-gitops/b0010-argocd.md)) und bei jeder Passwort-Rotation erneuert
    (`echo -n "<passwort>" | kubeseal --raw --namespace carplay-api --name carplay-api-shutdown-code --cert … --from-file=/dev/stdin`). Bleibt es `enabled: false`, blockiert `POST /api/power/shutdown` für
    `target=homeserver` mit 503, statt einen leeren Code stillschweigend zu akzeptieren.
  - Ein ntfy-Zugriffstoken ist nur nötig, falls ntfy von `auth-default-access: read-write` auf `deny-all` umgestellt wird.
- **power-agent:** Ein privilegierter Dienst direkt auf dem Homeserver ([60020](60020-ansible-rollen.md#power_agent)). Der Pod hat bewusst **keinen** Host-Zugriff (sysfs-Backlight, `sudo poweroff`, SSH-Key des
  `cluster_power_manager`), deshalb wird jede Helligkeits-/Wake-/Shutdown-Anfrage über das LAN an den Agenten weitergereicht, authentifiziert mit dessen eigenem Token. Der `PowerHandler` gibt den vom
  Agenten gemeldeten Statuscode zurück, damit z. B. ein nicht erreichbarer Homeserver-Bildschirm als echter Fehler in der App ankommt statt als irreführendes 200. Der Homeserver ist die dauerhaft laufende
  Steuerungsebene und hat **keinen WoL-Pfad** (nur worker-0/worker-1 lassen sich wecken, [20020](../2-betrieb-hardware/20020-cluster-power-manager.md)). Sein Shutdown nimmt den ganzen Cluster samt dieser API mit,
  deshalb hat er einen zusätzlichen Bestätigungsschritt.

### Datenquellen und ihre Eigenheiten

| Quelle | Hintergrund |
|---|---|
| VictoriaMetrics (`instance`-Label) | `HostConfig.instance` muss **exakt** dem `instance`-Label des `node-exporter`-Targets entsprechen. In diesem Cluster gibt es kein Relabeling auf Hostnamen, also `IP:9100` und nicht `homeserver:9100`. Erscheint ein Host nie als online: `curl vmsingle…/api/v1/targets`. Sechs PromQL-Queries laufen nebenläufig, jede nach `instance` gruppiert, sodass ein Roundtrip alle Hosts abdeckt. |
| Traefik-Aktivität | `ServiceConfig.match` ist ein **Teilstring** des rohen Traefik-`service`-Labels (Format je nach Provider/Chart-Version: `<ns>-<svc>-<port>@kubernetes` bei einem Ingress, `…@kubernetescrd` bei einer IngressRoute). So muss man das Format nicht festnageln, ohne das Live-Cluster abzufragen. Vor dem Deploy mit `curl $VM_URL/api/v1/label/service/values` gegenprüfen. Die Kennzahl ist die **Request-Rate**, **nicht** die Zahl verschiedener Nutzer (Traefik kennt keine Identitäten). Dienste, deren Teilstring nicht im Ergebnis vorkommt, stehen auf 0 Requests/s (noch nicht gescrapt oder wirklich idle). |
| PromQL-Regex | `regexAlternation` baut aus exakten Werten einen Regex (`a\|b\|c`) und escaped jeden, damit die Punkte in IPs nicht als Wildcard wirken. Das Ergebnis steckt in einem **doppelt gequoteten MetricsQL-String-Literal**: Ein einzelner Backslash (`regexp.QuoteMeta` macht aus `192.168.0.1` `192\.168\.0\.1`) wird von VictoriaMetrics als String-Escape geparst und mit **422** („cannot parse string literal“) abgelehnt, weil `\.` kein bekannter Escape ist. Der Backslash wird deshalb verdoppelt und ist beim Regex-Engine wieder einfach. |
| ntfy | Der echte, dokumentierte Polling-Endpunkt ist `GET /{topic}/json?poll=1` (kein REST-„list messages“, das gibt es bei ntfy nicht). `poll=1` liefert alles im Cache seit `since` und schließt die Verbindung. Mehrere Topics gehen nativ kommagetrennt (`/topic1,topic2/json`). Abonniert sind die zwei Topics, die wirklich Nachrichten bekommen: `Home-Lab` (Alertmanager `severity=critical` über `ntfy-bridge`) und `Home-Lab-System` (`thermal_watchdog`/`resource_watchdog`/`cluster_power_manager` auf dem Host). Der frühere Default `alerts` hat keinen Publisher, dort erschien nie etwas. Die ntfy-Prioritäten 1–5 werden auf **drei Stufen** abgebildet: Die 3 (ntfy-Default ohne explizite Priorität) zählt mit 1/2 als „info“, nicht als „warning“, damit nicht jede normale Benachrichtigung orange leuchtet. Sortierung: dringendste zuerst, dann neueste (ein Blick soll zuerst zeigen, was Aufmerksamkeit braucht, nicht was nur am neuesten ist). |
| Uptime Kuma | Es gibt keinen REST-Endpunkt mit Bearer-Token zum Auflisten der Monitore, die einzige stabile, dokumentierte Lese-API ist die **öffentliche** Status-Page-JSON-API (bewusst unauthentifiziert, das ist der Zweck einer Status-Page). Eine Status-Page mit dem konfigurierten Slug muss in der Kuma-UI existieren, mit **allen** anzuzeigenden Monitoren. Das JSON-Schema ist upstream nicht versioniert, deshalb wird defensiv geparst: Ein fehlendes oder falsch typisiertes Feld wird übersprungen, statt die ganze Antwort scheitern zu lassen. Der Ping kommt als **Bruchteil einer Millisekunde** (z. B. `0.457`), nicht als Ganzzahl, ein Decode nach `*int` ließ den ganzen Heartbeat-Abruf scheitern. Der Zeitstempel kommt naiv (`YYYY-MM-DD HH:mm:ss` in Serverzeit) oder als RFC3339, bei einem Parse-Fehler wird „jetzt“ genommen. Der Status `pending` (Check gerade fehlgeschlagen, Kuma wiederholt) zählt als **down**: Ein Blick-Dashboard soll sofort markieren, nicht auf die Bestätigung warten. |
| Update-Liste (`/api/updates`) | Liest die vom github-release-watcher geschriebene Update-Status-ConfigMap in **dessen** (anderem!) Namespace, über die In-Cluster-API und die namespace-übergreifende RoleBinding aus dessen `role.yaml`. Die Werte müssen zu `{{ fullname }}-updates` dort passen, bei abweichendem Release-Namen anpassen ([60040](60040-helm-charts-tech.md#github-release-watcher)). Sie wird 15 Minuten serverseitig gecacht, und der Watcher läuft nur alle 2 h. Die App ruft sie deshalb **einmal pro Ansicht** ab, nicht im 30-Sekunden-Loop. Zeiger-Felder sind `nil`, wenn unbekannt: `CurrentVersion` ist `nil`, bis jemand `currentVersion` im Watcher pflegt, `HasUpdate` bleibt `nil` (nicht `false`), wenn es nicht bestimmbar ist. Die App zeigt dann „unbekannt“ statt eines falschen „aktuell“. Existiert die ConfigMap, der Watcher lief aber noch nicht, ist das kein Fehler, nur nichts zu zeigen. |

---

## iOS-App

### Transport und Schlüssel

- **HTTP im Code, HTTPS im Cluster.** `Constants.swift` verweist auf `http://carplay-api.prod.homeserver` mit einer `NSAppTransportSecurity`-Ausnahme für die Domain `homeserver` (siehe
  [ios/README](../../ios/README.md), Abschnitt Transport). Diese Ausnahme wird aus `project.yml` in die `Info.plist` **generiert**: XcodeGen schreibt die Datei bei jedem `generate` aus diesen Eigenschaften und
  **überschreibt** sie komplett, statt mit handgemachtem Inhalt zu mergen. Alles, was die App braucht (Anzeigename, Launch Screen, Orientierung, ATS-Ausnahme), muss deshalb in `project.yml` stehen,
  sonst verschwindet es beim nächsten `xcodegen generate` still, und die App verweigert jeden `http://*.homeserver`-Request. Ein generiertes `.xcodeproj` lässt sich außerhalb von Xcode kaum von Hand pflegen oder
  diffen, deshalb wird das Projekt aus dem Text generiert und nicht eingecheckt (Setup: `brew install xcodegen`, `cd ios && xcodegen generate`).
- Die ATS-Ausnahme gilt nur für **Domainnamen**, nie für numerische IP-Literale. Die Basis-URL des `banana-pi-wol-agent` ist deshalb eine rohe Tailscale-IP und braucht **keine** Ausnahme (und ist ohnehin
  kein `*.homeserver`-Name, weil das Gerät nur per Tailscale erreichbar ist und aus dem Cluster nicht).
- **`MTLSDelegate` ist ein Erweiterungspunkt.** Die ursprüngliche Spezifikation wollte Zertifikats-Pinning. Ohne TLS-Handshake gäbe es nichts zu pinnen, eine Implementierung wäre eine Prüfung, die nie läuft.
  Echtes Client-Zertifikats-mTLS (Home-Lab-CA plus `RequireAndVerifyClientCert` am Traefik) ist eine unimplementierte Idee. Kommt sie, muss die IngressRoute die TLSOption `mtls-homelab` referenzieren, der
  Client-Identity-Zweig im Delegate aktiviert, das `.p12` des Geräts per Keychain bereitgestellt und die Basis-URL wieder auf `https://` gestellt werden.
- **Keychain statt „Secure Enclave“.** Die Spezifikation nannte die Secure Enclave, sie schützt aber private **Schlüssel** für Signieren/Entschlüsseln und hat keine API für ein beliebiges opakes Token wie ein
  Bearer-Credential. `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` ist das richtige Primitiv: geräteverschlüsselt, von iCloud-/iTunes-Backups ausgenommen und bei gesperrtem Gerät nicht lesbar, also genau die
  Sicherheitseigenschaft, die gemeint war. Der Wert wird als Ganzes neu geschrieben, deshalb „löschen dann hinzufügen“ statt `SecItemUpdate`.

### Netzwerk über Tailscale

- **Completion-Handler-API statt `async`-Variante** (`session.data(for:)`): Über Tailscales VPN-Tunnel (`NEPacketTunnelProvider`) brach die `async`-Variante **jeden** Request mit einem nackten
  `NSURLErrorCancelled` (-999) ohne zugrunde liegenden Fehler ab, eine bekannte Wechselwirkung von async/await-Bridging und Packet-Tunnel. Die Completion-Handler-API hat das Problem nicht.
- **`waitsForConnectivity = false`:** Früher verursachte es bei jedem Request ein scheinbar grundloses `NSURLErrorCancelled` (-999). Mit Tailscales VPN-Interface als ständig wechselndem Netzwerkpfad begann
  `URLSession` zu „warten“, bemerkte einen Pfadwechsel und brach das Warten ab, statt es zu wiederholen. Schnelles Scheitern lässt den eigenen 30-Sekunden-Polling-Loop den Retry übernehmen.
- Der **`RemoteWolAgentClient` dupliziert diese Request-Mechanik mit Absicht**, statt sie zu teilen: Der Workaround ist an eine konkrete, ohnehin fragile Tailscale-/URLSession-Interaktion gebunden. Bleiben die
  beiden Clients unabhängig, riskiert ein künftiger Fix an einem nicht, den anderen still zu brechen. Er spricht **direkt** mit dem Agenten auf dem Pi und **nicht** über carplay-api, weil dieser Pod keinen
  Netzwerkpfad zu Tailscale-Peers hat ([60020](60020-ansible-rollen.md#banana_pi_kiosk-vereinsheim-alarmmonitor)). Das Ziel-Enum muss zu einem Schlüssel in `banana_pi_kiosk_wol_devices` passen.
- **`TailscaleConnectivity`:** iOS hat keine öffentliche API, um „ist Tailscale verbunden“ zu fragen (der VPN-Status einer fremden App wird nicht offengelegt). Die Klasse tut das nächstbeste: Sie beobachtet den
  allgemeinen Netzwerkpfad (`NWPathMonitor`), damit die UI sofort „offline“ zeigen kann, statt einen Request-Timeout abzuwarten, und verfolgt getrennt, ob der **letzte echte Request** an carplay-api geklappt hat. Das
  ist das einzige echte Signal, dass Tailscale und API Ende zu Ende erreichbar sind.

### Modelle, Datenquellen, Bedienung

| Stelle | Begründung |
|---|---|
| Unbekannte Alert-Level fallen auf `.info` zurück | Ein unerwarteter Wert vom Backend soll nicht das Dekodieren des ganzen Dashboards scheitern lassen. |
| `alerts`/`hosts` per `decodeIfPresent` | Go serialisiert ein leeres/nil Slice als JSON `null`, nicht `[]`. `decodeIfPresent` behandelt ein explizites `null` wie einen fehlenden Schlüssel und fällt auf `[]` zurück, statt dass der `JSONDecoder` wirft. |
| `PowerTarget`-Rohwerte mit Bindestrich (`worker-0`) | Sie werden verbatim als JSON gesendet und müssen den Go-String-Konstanten exakt entsprechen. |
| Offline-Hosts werden ausgeblendet | Ein Host, der aus ist (herunterskalierter Worker, NAS im Reboot), wird nicht ausgegraut mit 0 % gezeigt, weil 0 % für einen Offline-Host keine echte Messung ist. |
| Letzter bekannter Stand bleibt bei Fehlern | Ein veralteter Wert ist besser als ein leerer Bildschirm ([ios/README](../../ios/README.md), „Offline-Verhalten“). Die Update-Karte scheitert **still** (nice-to-know, kein Banner über der Flottenübersicht). |
| Ein `DashboardViewModel` für alle Tabs | Ein Poll-Loop insgesamt statt einer pro Screen. Die Update-Abfrage liegt bewusst nicht im 30-Sekunden-Loop (Cache 15 min, Watcher alle 2 h), sondern einmal pro Ansicht bzw. Pull-to-Refresh. |
| Helligkeits-Slider schreibt erst beim Loslassen | Helligkeit schreibt über zwei Netzwerk-Hops (App → carplay-api → power-agent) in sysfs des Homeservers. Jeden Zwischenwert zu streamen würde veraltete Schreibvorgänge hinter dem aktuellen aufstauen. Die lokale Anzeige wird optimistisch aktualisiert und mit dem serverseitig begrenzten Wert abgeglichen. |
| Wake-on-LAN am Vereinsheim ohne Shutdown, ohne Online-Punkt | Das Ziel hat keinen Host-Eintrag in carplay-apis Dashboard, es gibt keinen Status außer dem Ergebnis des letzten Weckversuchs. capulus-core hat dafür auch keinen Remote-Shutdown-Pfad. |
| Shutdown-Code wird nie gespeichert oder vorbelegt | Der Code entspricht dem ArgoCD-Admin-Login und wird serverseitig geprüft. Der Homeserver-Shutdown hat zusätzlich eine Warnung. |
| Statusfarben | Grün unter 50 %, gelb 50–75 %, orange 75–90 %, rot über 90 % (CPU/RAM/Disk/Temperatur-Gauges der Host-Karten). |
| Zwei Modi (PKR-Lab, Alltag), persistiert | PKR-Lab sind die ursprünglichen drei Tabs (Übersicht, Steuerung, Alerts), Alltag zeigt Wetter, Tankstellen und News. Kein CarPlay-Scene, universelle iPhone-/iPad-App, kein Mac. Der Umschalter sitzt fest über dem Tab-Inhalt, weil der Moduswechsel das ganze Tab-Set ändert. |
| iPad: `.stack`-Navigation, Vollbild | Ohne `.stack` zeigt iPad einen Zwei-Spalten-Split (schmale Sidebar plus leerer Detail-Bereich). Die App ist nicht für das Größenänderungs-Fensterlayout (Split View, Slide Over, Stage Manager) gebaut und braucht `UIRequiresFullScreen`, sonst startet iPadOS sie als kleines schwebendes Fenster. iPad rotiert (Apple erwartet das), das iPhone bleibt Portrait-only. Der Launch Screen ist die moderne leere Dictionary-Form, weil sich `LaunchScreen.storyboard`-XML ohne Xcode nicht sinnvoll validieren lässt. Die `UITabBar` bekommt ein eigenes Aussehen, sonst fällt sie auch im erzwungenen Dark Mode auf ein helles Material zurück. |
| Erzwungener Dark Mode, „Glas“-Design | Die Design-Tokens stammen aus `css/style.css` der Website (tiefes Navy plus Rot auf fast schwarzem Verlauf), die App erzwingt Dark Mode, weil die Website keine helle Variante hat. Statusfarben behalten ihre universelle Bedeutung (online/warnung/offline) unabhängig von der Markenpalette. |
| Karten begrenzen die Breite | Auf dem iPad strecken sich Karten sonst von Rand zu Rand, auf dem iPhone hat die Begrenzung keinen Effekt. |

### Direkte Datenquellen der App (Alltag-Modus)

- **Tankerkönig:** Die App fragt die API direkt mit einem **eigenen API-Key im Keychain** des Geräts, statt über das clusterseitige SealedSecret von Glance. Zeigt nur Super (E5) und Super E10, kein Diesel.
  Für geschlossene Stationen sendet Tankerkönig `false` statt einer Zahl, was als „kein Preis“ gilt statt als Fehler. Die nächste Station wird per Umkreissuche (`sort=dist`) gefunden, die erste nicht ausgeschlossene
  Marke ist die nächste passende. **Shell und Aral** sind ausgeschlossen, dazu Agip/Eni (in Deutschland umbenannt, in den Daten unter beiden Namen gesehen).
- **Standort:** Ist nur „Ungefährer Standort“ erlaubt, liefert `requestLocation()` allein eine um mehrere km verwischte Koordinate, genug, um eine echt nahe (z. B. 5 km entfernte) Tankstelle aus der Umkreissuche zu
  drücken. Deshalb wird temporär volle Genauigkeit angefordert (`NSLocationTemporaryUsageDescriptionDictionary` in der Info.plist).
- **Wetter:** Open-Meteo, kein API-Key nötig, gleiche Felder wie Glances „Wetter — Morgen“-Widget plus Windspitze, für heute und morgen in einer Abfrage. Die Zeiten sind lokale (ohne Offset) Werte in Europe/Berlin
  (der angeforderten `timezone`). **Feste Locale beim Parsen:** Ohne sie fällt der `DateFormatter` auf die Locale/den Kalender des Geräts zurück (z. B. nicht-gregorianische Regionaleinstellung), `date(from:)` liefert
  still `nil` und die ganze Sonnenbogen-Karte verschwindet. Der Sonnenverlauf ist ein Bogen aus einer quadratischen Bezier-Kurve statt einer echten Ellipse (genügt visuell und macht die Positionsberechnung
  fürs Sonne-/Mond-Symbol trivial, weil dieselbe Formel zum Zeichnen und Platzieren dient).
- **Pegel:** Pegelonline (WSV) ohne API-Key. Die Stations-UUID für Andernach wurde einmal über `/stations.json?waters=RHEIN` nachgeschlagen und fest eingetragen (ein Pegel bewegt sich nicht). Für `stateMnwMhw` gibt es
  nur drei dokumentierte Werte (niedrig/normal/hoch relativ zu mittlerem Niedrig-/Hochwasser), alles andere bleibt der Rohcode.
- **News:** Je eine Schlagzeile von Tagesschau (öffentliches, inoffizielles JSON), Heise und WELT (RSS/Atom). Die Feeds sind nicht versioniert: Ändert ein Anbieter sein Schema, scheitert **nur diese Quelle**
  („Nicht verfügbar“), nicht die ganze Seite. Der Parser liest nur das erste Item (RSS `<item>` oder Atom `<entry>`) und bricht dann ab (der Abbruchfehler ist erwartet). Atoms `<link>` ist ein selbstschließendes
  Element mit `href`, RSS 2.0 hat den Link als Text, und `<description>` (RSS) bzw. `<summary>`/`<content>` (Atom) landen im selben Kurztext-Feld. HTML-Markup und Entitäten der Beschreibungen werden entfernt.
- Die **Kurzlink-Kacheln** der Dienste sind reine Link-Listen ohne eigenen Live-Status und öffnen den Dienst in Safari (nicht in der `URLSession` der App, die ATS-Ausnahme spielt dort keine Rolle).
