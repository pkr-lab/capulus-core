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
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        authorizationStatus = manager.authorizationStatus
    }

    /// Requests one fresh location fix, prompting for "When In Use"
    /// authorization first if it hasn't been decided yet. Throws if the
    /// user denies access or the fix fails.
    func requestLocation() async throws -> CLLocation {
        try await withCheckedThrowingContinuation { continuation in
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
