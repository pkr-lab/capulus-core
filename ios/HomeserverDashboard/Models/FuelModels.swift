import Foundation

/// One of Glance's three fixed Tankerkönig-Stationen (see
/// argocd/apps/glance/templates/configmap.yaml).
struct FuelStation: Identifiable, Equatable {
    let id: String
    let name: String
    let address: String
}

/// Decodes Tankerkönig's `prices.php` response. Only `e5`/`e10` are kept —
/// this app shows Super/Super E10 only, no Diesel.
struct TankerkoenigPricesResponse: Decodable {
    let ok: Bool
    let message: String?
    let prices: [String: StationPrices]?

    struct StationPrices: Decodable {
        let status: String
        let e5: Double?
        let e10: Double?

        enum CodingKeys: String, CodingKey {
            case status, e5, e10
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            status = try container.decode(String.self, forKey: .status)
            // Tankerkönig sends `false` instead of a number for closed
            // stations' price fields — decoding as Double fails for those,
            // which we treat as "no price" rather than propagating an error.
            e5 = try? container.decode(Double.self, forKey: .e5)
            e10 = try? container.decode(Double.self, forKey: .e10)
        }
    }
}

/// Decodes Tankerkönig's `list.php` (radius search) response, used to find
/// the nearest non-Shell/Aral station to the device's current location.
struct TankerkoenigListResponse: Decodable {
    let ok: Bool
    let message: String?
    let stations: [NearbyStation]?

    struct NearbyStation: Decodable, Identifiable {
        let id: String
        let name: String
        let brand: String
        let street: String
        let houseNumber: String?
        let place: String
        let dist: Double
        let isOpen: Bool
        let e5: Double?
        let e10: Double?

        enum CodingKeys: String, CodingKey {
            case id, name, brand, street, houseNumber, place, dist, isOpen, e5, e10
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            name = try container.decode(String.self, forKey: .name)
            brand = try container.decodeIfPresent(String.self, forKey: .brand) ?? ""
            street = try container.decodeIfPresent(String.self, forKey: .street) ?? ""
            houseNumber = try container.decodeIfPresent(String.self, forKey: .houseNumber)
            place = try container.decodeIfPresent(String.self, forKey: .place) ?? ""
            dist = try container.decodeIfPresent(Double.self, forKey: .dist) ?? 0
            isOpen = try container.decodeIfPresent(Bool.self, forKey: .isOpen) ?? false
            // Same "false instead of a number when closed" quirk as
            // StationPrices above.
            e5 = try? container.decode(Double.self, forKey: .e5)
            e10 = try? container.decode(Double.self, forKey: .e10)
        }
    }
}
