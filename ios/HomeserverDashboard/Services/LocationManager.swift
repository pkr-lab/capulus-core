import CoreLocation
import Combine

enum LocationError: LocalizedError {
    case denied

    var errorDescription: String? {
        "Standortzugriff wurde nicht erlaubt — in den iOS-Einstellungen für diese App aktivieren."
    }
}

/// Thin CLLocationManager wrapper for the "nächste Tankstelle" lookup in
/// TankstellenView (Alltag-Modus) — the app has no other use for the
/// device's location.
final class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = LocationManager()

    @Published private(set) var authorizationStatus: CLAuthorizationStatus = .notDetermined

    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        authorizationStatus = manager.authorizationStatus
    }

    /// Requests one fresh location fix, prompting for "When In Use"
    /// authorization first if it hasn't been decided yet. Throws if the
    /// user denies access or the fix fails.
    ///
    /// If the user only granted "Approximate Location", `requestLocation()`
    /// alone would hand back a coordinate fuzzed by several km — enough to
    /// push a genuinely nearby (e.g. 5 km away) gas station outside the
    /// Tankerkönig radius search entirely. Requesting temporary full
    /// accuracy first (see `NSLocationTemporaryUsageDescriptionDictionary`
    /// in Info.plist) fixes that for this one-shot lookup.
    func requestLocation() async throws -> CLLocation {
        if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways,
           manager.accuracyAuthorization == .reducedAccuracy {
            try? await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "TankstellenSuche") { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            if manager.authorizationStatus == .notDetermined {
                manager.requestWhenInUseAuthorization()
            } else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
                continuation.resume(throwing: LocationError.denied)
                self.continuation = nil
            } else {
                manager.requestLocation()
            }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationStatus = manager.authorizationStatus
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            if continuation != nil { manager.requestLocation() }
        case .denied, .restricted:
            continuation?.resume(throwing: LocationError.denied)
            continuation = nil
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        continuation?.resume(returning: location)
        continuation = nil
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
