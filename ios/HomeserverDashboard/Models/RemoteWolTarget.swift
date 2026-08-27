import Foundation

/// Devices at the vereinsheim-alarmmonitor site that can be woken via
/// Wake-on-LAN, relayed through the Pi itself (NOT through carplay-api —
/// see RemoteWolAgentClient.swift for why). `rawValue` must match a key
/// in `banana_pi_kiosk_wol_devices`
/// (ansible/host_vars/vereinsheim-alarmmonitor/vars.yml).
enum RemoteWolTarget: String, Identifiable, CaseIterable {
    case windowsPC = "windows-pc"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .windowsPC: return "Windows-PC (Vereinsheim)"
        }
    }
}
