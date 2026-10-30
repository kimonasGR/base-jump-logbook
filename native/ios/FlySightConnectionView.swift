import SwiftUI

struct FlySightConnectionView: View {
    @StateObject private var bluetooth = FlySightBLEClient()

    var body: some View {
        NavigationStack {
            List {
                Section("Bluetooth") {
                    HStack {
                        Text("Status")
                        Spacer()
                        Text(statusText).foregroundStyle(.secondary)
                    }
                    Button("Scan for FlySight 2") { bluetooth.startScan() }
                        .disabled(bluetooth.state == .scanning || bluetooth.state == .poweredOff || bluetooth.state == .unavailable)
                    if bluetooth.state == .scanning {
                        HStack { ProgressView(); Text("Searching for nearby FlySight devices…") }
                    }
                }

                if !bluetooth.discoveredDevices.isEmpty {
                    Section("Detected devices") {
                        ForEach(bluetooth.discoveredDevices) { device in
                            Button {
                                bluetooth.connect(to: device.peripheral)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(device.name).foregroundStyle(.primary)
                                        Text(device.id.uuidString).font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if bluetooth.deviceName == device.name && bluetooth.state == .connected {
                                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                                    }
                                }
                            }
                        }
                    }
                }

                Section("FlySight telemetry") {
                    valueRow("Battery", bluetooth.batteryPercent.map { "\($0)%" } ?? "—")
                    valueRow("Device mode", bluetooth.deviceMode.map(String.init) ?? "—")
                    if let sample = bluetooth.latestGNSS {
                        valueRow("Latitude", sample.latitude.map { String(format: "%.7f", $0) } ?? "—")
                        valueRow("Longitude", sample.longitude.map { String(format: "%.7f", $0) } ?? "—")
                        valueRow("Altitude MSL", sample.altitudeMslMeters.map { String(format: "%.1f m", $0) } ?? "—")
                        valueRow("Vertical velocity", sample.velocityDownMps.map { String(format: "%.2f m/s", $0) } ?? "—")
                        valueRow("Satellites", sample.satellites.map(String.init) ?? "—")
                    } else {
                        Text("GNSS values appear when the FlySight is in Active or Start mode and telemetry notifications are enabled.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }

                Section {
                    Text("This is a native iOS integration prototype. Pairing, live telemetry and file transfer must be validated against the exact FlySight firmware and a physical device before operational use.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("BASE Logbook · FlySight")
            .toolbar {
                if bluetooth.state == .connected {
                    Button("Disconnect") { bluetooth.disconnect() }
                }
            }
        }
    }

    private var statusText: String {
        switch bluetooth.state {
        case .unavailable: return "Bluetooth unavailable"
        case .poweredOff: return "Bluetooth is off"
        case .scanning: return "Scanning"
        case .connecting: return "Connecting"
        case .pairingRequired: return "Pairing required — accept the iOS prompt"
        case .connected: return "Connected"
        case .disconnected(let message): return message
        }
    }

    @ViewBuilder
    private func valueRow(_ title: String, _ value: String) -> some View {
        HStack { Text(title); Spacer(); Text(value).foregroundStyle(.secondary).monospacedDigit() }
    }
}
