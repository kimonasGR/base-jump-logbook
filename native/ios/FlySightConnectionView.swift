import SwiftUI

struct FlySightConnectionView: View {
    @StateObject private var bluetooth = FlySightBLEClient()
    @State private var files: [FlySightBLEClient.FlySightFile] = []
    @State private var downloadedFiles: [URL] = []
    @State private var isListing = false
    @State private var downloadingName: String?
    @State private var transferSaveError: String?

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

                Section("Device files · Idle mode only") {
                    Button {
                        isListing = true
                        bluetooth.listDirectory(path: "/") { result in
                            isListing = false
                            if case .success(let entries) = result { files = entries }
                        }
                    } label: {
                        if isListing { ProgressView("Reading directory…") }
                        else { Label("Read FlySight files", systemImage: "folder") }
                    }
                    .disabled(bluetooth.state != .connected || isListing || downloadingName != nil)
                    if files.isEmpty {
                        Text("Switch FlySight to Idle mode (LED off), connect, then read the device directory.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(files.filter { $0.name.uppercased().hasSuffix(".CSV") }) { file in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(file.name)
                                Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(downloadingName == file.name ? "Downloading…" : "Download") {
                                download(file)
                            }
                            .disabled(downloadingName != nil || bluetooth.state != .connected)
                        }
                    }
                    if downloadingName != nil {
                        ProgressView(value: bluetooth.transferProgress)
                        Button("Cancel transfer", role: .destructive) { bluetooth.cancelFileTransfer(); downloadingName = nil }
                    }
                    if !bluetooth.transferStatus.isEmpty {
                        Text(bluetooth.transferStatus).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let transferSaveError {
                        Text(transferSaveError).font(.footnote).foregroundStyle(.red)
                    }
                }

                if !downloadedFiles.isEmpty {
                    Section("Saved on this iPhone") {
                        ForEach(downloadedFiles, id: \.absoluteString) { url in
                            ShareLink(item: url) {
                                Label(url.lastPathComponent, systemImage: "square.and.arrow.up")
                            }
                        }
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

    private func download(_ file: FlySightBLEClient.FlySightFile) {
        downloadingName = file.name
        bluetooth.downloadFile(path: file.name, expectedSize: file.size) { result in
            downloadingName = nil
            switch result {
            case .success(let data):
                do {
                    let folder = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                        .appendingPathComponent("FlySight Imports", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: nil)
                    let destination = folder.appendingPathComponent(file.name)
                    try data.write(to: destination, options: .atomic)
                    if !downloadedFiles.contains(destination) { downloadedFiles.append(destination) }
                } catch {
                    transferSaveError = "Could not save file: " + error.localizedDescription
                }
            case .failure:
                break
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
