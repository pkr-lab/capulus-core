# Homeserver CarPlay Dashboard (iOS)

SwiftUI + CarPlay client for [carplay-api](../argocd/apps/carplay-api/) —
alerts (ntfy), fleet metrics (VictoriaMetrics) and service status
(Uptime-Kuma) as a 3-tab CarPlay dashboard, plus a phone companion screen.

**Read this before opening Xcode** — two things here don't match a literal
reading of the original spec, and both matter before you invest time in a
build/entitlement request.

## CarPlay-Entitlement — read this first

CarPlay isn't an open platform. Every third-party CarPlay app must declare
one of Apple's fixed use-case entitlements (navigation, parking, EV
charging, quick-food-ordering, driver-training, communication/messaging,
fueling, media, parking) in its App ID, and Apple manually reviews the
*written request* for that entitlement before granting it — it's tied to
what the app actually does, not to who's asking or how it's distributed.

A generic system/homelab dashboard (server metrics, alerts, uptime) doesn't
fit any of those categories. Realistically:

- **Today, with no entitlement**: this project builds and runs fully in
  **Xcode's CarPlay Simulator** (Xcode → Window → Devices and Simulators →
  pick a simulator → CarPlay icon in the toolbar once the app is running).
  That's the actual target for this build — no Apple approval needed, full
  3-tab dashboard, live data.
- **Real car hardware or TestFlight to anyone other than yourself**: needs
  the entitlement request approved. A personal ops dashboard is unlikely to
  qualify under any current category. If you want to pursue it anyway, the
  closest fit is **Communication** (frame alerts as messages) — see
  `CarPlaySceneDelegate.swift`'s doc comment for what would need to change.
- **TestFlight *internal* testing** (your own account, devices you own) —
  the app itself can be uploaded and installed without App Store review,
  but CarPlay still won't activate on a real head unit without the
  entitlement; the app would just behave as a phone-only app on real
  hardware, same as it does in TestFlight today without one.

## Why HTTP, not HTTPS

Every `*.homeserver` service in this cluster is plain HTTP behind Traefik —
check any `argocd/apps/*/values.yaml`, `ingress.tls` is empty everywhere.
Client-cert mTLS (`docs/14-cert-login.md` in capulus-core) is a real,
partially-built plan, but it's not merged and today only targets a handful
of admin UIs (Authentik, Grafana), not this API. `Constants.swift` points at
`http://carplay-api.homeserver` to match that live reality, with an
`NSAppTransportSecurity` exception in `Info.plist` for the `homeserver`
domain. `MTLSDelegate.swift` documents exactly what to change if/when that
migration reaches carplay-api.

## Structure

```
ios/
├── project.yml                    # XcodeGen spec — source of truth, .xcodeproj is generated, not committed
├── .gitignore
└── CarPlayDashboard/
    ├── CarPlayApp.swift            # @main SwiftUI entry point
    ├── AppDelegate.swift           # Routes the CarPlay scene to CarPlaySceneDelegate
    ├── Info.plist
    ├── CarPlayDashboard.entitlements
    ├── CarPlay/
    │   ├── CarPlaySceneDelegate.swift
    │   └── DashboardTemplateBuilder.swift
    ├── Views/                      # Phone companion UI
    ├── ViewModels/DashboardViewModel.swift
    ├── Models/                     # Codable, 1:1 with carplay-api's JSON
    ├── Services/                   # API client, Keychain, connectivity
    ├── Utilities/                  # Colors, formatting, constants
    └── Assets.xcassets/
```

### CarPlay layout: tabs, not columns

The spec describes a simultaneous 3-column grid. CarPlay's template API has
no such primitive for rich, per-row content — `CPListTemplate` is a single
scrollable column, and `CPGridTemplate` caps out at ~8 static icon+title
buttons with no subtitle text (fine for launching actions, not for alert
text or ping times). What's actually shipped is a `CPTabBarTemplate` with
one `CPListTemplate` per column (Alerts / Metrics / Status) — the driver
switches between them instead of seeing all three at once. Same data, same
colors/icons, different navigation model. See the doc comment at the top of
`DashboardTemplateBuilder.swift`.

## Setup

### 1. Generate the Xcode project

```bash
brew install xcodegen
cd ios
xcodegen generate
open CarPlayDashboard.xcodeproj
```

Set `PRODUCT_BUNDLE_IDENTIFIER` / your Team in Xcode's Signing & Capabilities
if `com.yourname.homeserver-carplay` (`project.yml`) isn't yours.

### 2. Get an API token

Requires carplay-api already deployed with a sealed `CARPLAY_API_TOKEN` —
see [`docs/43-carplay-api.md`](../docs/43-carplay-api.md#ersteinrichtung) in
capulus-core. Run the app (Simulator or device), tap the gear icon → paste
the same token you sealed for the backend → **Save to Keychain**.

### 3. Run in the CarPlay Simulator

1. Run the app normally in an iOS Simulator (⌘R).
2. Xcode → **Window → Devices and Simulators** → select the running
   simulator → click the CarPlay icon in its toolbar (turns on a virtual
   head unit window).
3. The dashboard's 3-tab layout appears there; the phone window shows the
   companion screen.

Both windows share one `DashboardViewModel` instance and one 30s polling
loop — updating one updates the other.

## Configuration

| Setting | Where | Default |
|---|---|---|
| API base URL | `Utilities/Constants.swift` → `apiBaseURL` | `http://carplay-api.homeserver` |
| Refresh interval | `Constants.swift` → `refreshInterval` | 30s |
| Bearer token | Settings screen (gear icon) → iOS Keychain | none until set |

Reachability requires Tailscale active on the device (or being on the LAN)
— see `Services/TailscaleConnectivity.swift` for what this app can and
can't actually detect about that (iOS gives no app visibility into another
app's VPN state; it watches the general network path plus whether the last
real request succeeded).

## Deviations from the original file list / spec

- **`MTLSDelegate.swift`**: kept as the requested filename, but implements
  standard TLS handling + a documented extension point for a *future* client
  certificate, not active pinning — see "Why HTTP, not HTTPS" above.
- **Entitlements**: dropped "Keychain Sharing" and "Network Extensions" from
  `CarPlayDashboard.entitlements` — neither applies. Keychain Sharing is for
  sharing items *between your own multiple app targets/extensions* (this
  project has one target). Network Extension entitlements are for apps that
  *implement* a VPN/DNS provider; this app just rides on Tailscale's
  already-active system VPN, which needs zero entitlement on its part.
- **LaunchScreen**: `Info.plist`'s `UILaunchScreen` empty-dict form (iOS
  14+) instead of a hand-authored `LaunchScreen.storyboard` — storyboard XML
  can't be meaningfully validated without Xcode itself; the plist form is
  Apple's own current recommendation and carries no such risk.
- **`.xcodeproj` not committed**: generated from `project.yml` via
  XcodeGen instead, for the same reason this repo's k8s apps are Helm
  charts, not hand-edited YAML — a generated project file can't be
  meaningfully reviewed or merged by hand.

## Known gaps (not implemented)

- **Unit tests**: none. `Models/` (Codable round-trips against real
  carplay-api responses) and `DashboardTemplateBuilder` (section-building
  logic) are the highest-value targets if you add them.
- **App icon**: `Assets.xcassets/AppIcon.appiconset` has a valid 1024×1024
  slot defined but no actual image — add one before archiving for
  TestFlight, Xcode will otherwise reject the archive.
- **Privacy policy / App Store screenshots**: needed for any TestFlight
  *external* testing group or App Store submission, not for internal
  testing or the Simulator. Not produced here — no product copy or Apple
  Developer account access from this environment.
- **Swift Concurrency**: written under default ("minimal") concurrency
  checking, not Swift 6 strict mode — if you turn strict concurrency on in
  `project.yml`, expect to have to adjust a few `@MainActor` boundaries in
  `CarPlaySceneDelegate.swift`.
