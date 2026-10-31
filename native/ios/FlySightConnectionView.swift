import SwiftUI
import CryptoKit

struct FlySightConnectionView: View {
    @StateObject private var bluetooth = FlySightBLEClient()
    @State private var files: [FlySightBLEClient.FlySightFile] = []
    @State private var downloadedFiles: [URL] = []
    @State private var selectedForImport: Set<String> = []
    @State private var isListing = false
    @State private var downloadingName: String?
    @State private var transferSaveError: String?
    @State private var apiBaseURL = "https://base-jump-logbook.vercel.app"
    @State private var handoffToken = ""
    @State private var uploadStatus = ""
    @State private var isUploading = false

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
                    ForEach(files.filter { let name = $0.name.uppercased(); return name.hasSuffix(".CSV") || name.hasSuffix(".GPX") }) { file in
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

                Section("Secure upload to your logbook") {
                    TextField("Logbook address", text: $apiBaseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    SecureField("10-minute handoff token", text: $handoffToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task { await uploadSelectedFiles() }
                    } label: {
                        if isUploading { ProgressView(uploadStatus.isEmpty ? "Uploading…" : uploadStatus) }
                        else { Label("Upload selected FlySight files", systemImage: "lock.shield") }
                    }
                    .disabled(isUploading || selectedForImport.isEmpty || apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || handoffToken.trimmingCharacters(in: .whitespacesAndNewlines).count != 64)
                    if !uploadStatus.isEmpty {
                        Text(uploadStatus).font(.footnote).foregroundStyle(.secondary)
                    }
                    Text("In your signed-in BASE Logbook, open Settings → FlySight and create a 10-minute token. Paste it here. The app address is pre-filled; the token can upload only FlySight source files and cannot access your account.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                if !downloadedFiles.isEmpty {
                    Section("Ready to import into your logbook") {
                        Text("Select TRACK.CSV and SENSOR.CSV together. Share the selected files, then choose the BASE Logbook web app's import screen and select both files in one operation.")
                            .font(.footnote).foregroundStyle(.secondary)
                        ForEach(downloadedFiles, id: \.absoluteString) { url in
                            Toggle(isOn: Binding(
                                get: { selectedForImport.contains(url.absoluteString) },
                                set: { selected in
                                    if selected { selectedForImport.insert(url.absoluteString) }
                                    else { selectedForImport.remove(url.absoluteString) }
                                }
                            )) {
                                Label(url.lastPathComponent, systemImage: "doc.text")
                            }
                        }
                        ShareLink(items: downloadedFiles.filter { selectedForImport.contains($0.absoluteString) }) {
                            Label("Share selected files together", systemImage: "square.and.arrow.up")
                        }
                        .disabled(selectedForImport.isEmpty)
                        Button("Select TRACK.CSV + SENSOR.CSV") {
                            selectedForImport = Set(downloadedFiles.filter {
                                let name = $0.lastPathComponent.uppercased()
                                return name == "TRACK.CSV" || name == "SENSOR.CSV"
                            }.map(\.absoluteString))
                        }
                        .disabled(!downloadedFiles.contains { $0.lastPathComponent.uppercased() == "TRACK.CSV" } ||
                                  !downloadedFiles.contains { $0.lastPathComponent.uppercased() == "SENSOR.CSV" })
                    }
                }

                Section {
                    Text("FlySight 2 connection and transfer require a compatible device in Idle mode. Verify imported measurements before saving a jump. Hardware compatibility still requires validation on a physical iPhone and FlySight 2.")
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


    private func uploadSelectedFiles() async {
        guard let base = URL(string: apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = base.scheme?.lowercased(), scheme == "https",
              base.host != nil else {
            uploadStatus = "Enter the HTTPS address of your deployed logbook API."
            return
        }
        let token = handoffToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.range(of: "^[A-Fa-f0-9]{64}$", options: .regularExpression) != nil else {
            uploadStatus = "Paste the complete 64-character handoff token without extra characters."
            return
        }
        let selected = downloadedFiles.filter { selectedForImport.contains($0.absoluteString) }
        guard !selected.isEmpty else { uploadStatus = "Select at least one file."; return }
        isUploading = true
        defer { isUploading = false }
        do {
            for fileURL in selected {
                let name = fileURL.lastPathComponent.uppercased()
                guard ["TRACK.CSV", "SENSOR.CSV", "TRACK.GPX"].contains(name) else {
                    throw UploadError.message("Unsupported file: \(name)")
                }
                let data = try Data(contentsOf: fileURL)
                guard !data.isEmpty, data.count <= 15 * 1024 * 1024 else {
                    throw UploadError.message("\(name) is empty or exceeds 15 MB.")
                }
                let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                let chunkSize = 256 * 1024
                let totalChunks = (data.count + chunkSize - 1) / chunkSize
                for index in 0..<totalChunks {
                    let start = index * chunkSize
                    let end = min(start + chunkSize, data.count)
                    let chunk = data.subdata(in: start..<end)
                    let payload: [String: Any] = [
                        "fileName": name,
                        "fileSize": data.count,
                        "sha256": digest,
                        "chunkIndex": index,
                        "totalChunks": totalChunks,
                        "data": chunk.base64EncodedString()
                    ]
                    var endpoint = base
                    endpoint.append(path: "/api/flysight/handoffs/upload")
                    var request = URLRequest(url: endpoint)
                    request.httpMethod = "POST"
                    request.timeoutInterval = 45
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue(token, forHTTPHeaderField: "X-FlySight-Handoff")
                    request.httpBody = try JSONSerialization.data(withJSONObject: payload)
                    _ = try await sendUploadRequest(request)
                    uploadStatus = "\(name): \(index + 1)/\(totalChunks) chunks"
                }
                uploadStatus = "\(name) uploaded and integrity-checked."
            }
            uploadStatus = "Upload complete. Open the logbook import inbox to add the files to a jump draft."
        } catch {
            uploadStatus = error.localizedDescription
        }
    }

    private func sendUploadRequest(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        for attempt in 0..<3 {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw UploadError.message("Upload returned an invalid server response.")
                }
                if (200...299).contains(http.statusCode) { return (data, http) }
                let retryable = http.statusCode == 408 || http.statusCode == 429 || http.statusCode >= 500
                let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                if !retryable || attempt == 2 {
                    throw UploadError.message(detail ?? "Upload failed (HTTP \(http.statusCode)).")
                }
            } catch let error as UploadError {
                throw error
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if attempt == 2 { throw error }
            }
            try await Task.sleep(nanoseconds: UInt64(1 << attempt) * 1_000_000_000)
        }
        throw UploadError.message("Upload failed after three attempts.")
    }

    private enum UploadError: LocalizedError {
        case message(String)
        var errorDescription: String? {
            if case .message(let text) = self { return text }
            return nil
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
