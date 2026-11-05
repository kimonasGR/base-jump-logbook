import SwiftUI
import CryptoKit

struct FlySightConnectionView: View {
    @StateObject private var bluetooth = FlySightBLEClient()
    @State private var files: [FlySightBLEClient.FlySightFile] = []
    @State private var currentDirectory = "/"
    @State private var downloadedFiles: [URL] = []
    @State private var selectedForImport: Set<String> = []
    @State private var isListing = false
    @State private var downloadingName: String?
    @State private var transferSaveError: String?
    private let apiBaseURL = URL(string: "https://base-jump-logbook.vercel.app")!
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
                    if bluetooth.state == .scanning {
                        Button("Stop scanning", role: .cancel) { bluetooth.stopScan() }
                        HStack { ProgressView(); Text("Searching for nearby FlySight devices… (up to 20 seconds)") }
                    } else {
                        Button("Scan for FlySight 2") { bluetooth.startScan() }
                            .disabled(bluetooth.state == .poweredOff || bluetooth.state == .unavailable)
                    }
                    Text("Unplug the FlySight from USB, switch it on, then double-press its button. Connect while the green LED is pulsing (about 30 seconds).")
                        .font(.footnote).foregroundStyle(.secondary)
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
                            .disabled(bluetooth.state == .connected || bluetooth.state == .connecting || bluetooth.state == .pairingRequired)
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
                    HStack {
                        Text(currentDirectory).font(.caption.monospaced()).foregroundStyle(.secondary)
                        Spacer()
                        if currentDirectory != "/" {
                            Button("Up one level") {
                                let parent = URL(fileURLWithPath: currentDirectory).deletingLastPathComponent().path
                                readDirectory(parent.isEmpty ? "/" : parent)
                            }
                            .disabled(isListing || downloadingName != nil)
                        }
                    }
                    Button {
                        readDirectory(currentDirectory)
                    } label: {
                        if isListing { ProgressView("Reading directory…") }
                        else { Label("Read this directory", systemImage: "arrow.clockwise") }
                    }
                    .disabled(bluetooth.state != .connected || isListing || downloadingName != nil)
                    if files.isEmpty {
                        Text("Connect while FlySight is in Idle mode (LED off), then read the directory. Open the date and session folders to find TRACK.CSV and SENSOR.CSV.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(files.filter(\.isDirectory)) { folder in
                        Button {
                            readDirectory(folder.path)
                        } label: {
                            Label(folder.name, systemImage: "folder")
                        }
                        .disabled(isListing || downloadingName != nil || bluetooth.state != .connected)
                    }
                    ForEach(files.filter { file in
                        let name = file.name.uppercased()
                        return !file.isDirectory && (name.hasSuffix(".CSV") || name.hasSuffix(".GPX"))
                    }) { file in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(file.name)
                                Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(downloadingName == file.path ? "Downloading…" : "Download") {
                                download(file)
                            }
                            .disabled(downloadingName != nil || bluetooth.state != .connected)
                        }
                    }
                    if downloadingName != nil {
                        ProgressView(value: bluetooth.transferProgress)
                        Button("Cancel transfer", role: .destructive) { bluetooth.cancelOperation(); downloadingName = nil }
                    } else if isListing {
                        Button("Cancel directory read", role: .destructive) { bluetooth.cancelOperation() }
                    }
                    if !bluetooth.transferStatus.isEmpty {
                        Text(bluetooth.transferStatus).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let transferSaveError {
                        Text(transferSaveError).font(.footnote).foregroundStyle(.red)
                    }
                }

                Section("Secure upload to your logbook") {
                    Label("Destination: base-jump-logbook.vercel.app", systemImage: "lock.shield")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    SecureField("10-minute handoff token", text: $handoffToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task { await uploadSelectedFiles() }
                    } label: {
                        if isUploading { ProgressView(uploadStatus.isEmpty ? "Uploading…" : uploadStatus) }
                        else { Label("Upload selected FlySight files", systemImage: "lock.shield") }
                    }
                    .disabled(isUploading || selectedForImport.isEmpty || handoffToken.trimmingCharacters(in: .whitespacesAndNewlines).count != 64)
                    if !uploadStatus.isEmpty {
                        Text(uploadStatus).font(.footnote).foregroundStyle(.secondary)
                    }
                    Text("In your signed-in BASE Logbook, open Settings → FlySight and create a 10-minute token. Paste it here. The app address is pre-filled; the token can upload only FlySight source files and cannot access your account.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                if !downloadedFiles.isEmpty {
                    Section("Ready to import into your logbook") {
                        Text("Downloaded files keep their original date/session folders. Select TRACK.CSV and, when available, SENSOR.CSV from the same session before uploading.")
                            .font(.footnote).foregroundStyle(.secondary)
                        ForEach(downloadedFiles, id: \.absoluteString) { url in
                            Toggle(isOn: Binding(
                                get: { selectedForImport.contains(url.absoluteString) },
                                set: { selected in
                                    if selected { selectedForImport.insert(url.absoluteString) }
                                    else { selectedForImport.remove(url.absoluteString) }
                                }
                            )) {
                                Label(url.deletingLastPathComponent().lastPathComponent + " / " + url.lastPathComponent, systemImage: "doc.text")
                            }
                        }
                        ShareLink(items: downloadedFiles.filter { selectedForImport.contains($0.absoluteString) }) {
                            Label("Share selected files together", systemImage: "square.and.arrow.up")
                        }
                        .disabled(selectedForImport.isEmpty)
                        Button("Select TRACK.CSV + SENSOR.CSV from one session") {
                            let sessionFolder = downloadedFiles.first(where: { selectedForImport.contains($0.absoluteString) })?.deletingLastPathComponent()
                                ?? downloadedFiles.last?.deletingLastPathComponent()
                            guard let sessionFolder else { return }
                            selectedForImport = Set(downloadedFiles.filter {
                                $0.deletingLastPathComponent() == sessionFolder &&
                                ["TRACK.CSV", "SENSOR.CSV"].contains($0.lastPathComponent.uppercased())
                            }.map(\.absoluteString))
                        }
                        .disabled(!downloadedFiles.contains { $0.lastPathComponent.uppercased() == "TRACK.CSV" })
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
        let base = apiBaseURL
        guard base.scheme?.lowercased() == "https",
              base.host?.lowercased() == "base-jump-logbook.vercel.app",
              base.user == nil, base.password == nil, base.port == nil,
              base.path.isEmpty || base.path == "/" else {
            uploadStatus = "The upload destination is not trusted."
            return
        }
        let token = handoffToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.range(of: "^[A-Fa-f0-9]{64}$", options: .regularExpression) != nil else {
            uploadStatus = "Paste the complete 64-character handoff token without extra characters."
            return
        }
        let selected = downloadedFiles.filter { selectedForImport.contains($0.absoluteString) }
        guard !selected.isEmpty else { uploadStatus = "Select at least one file."; return }
        guard Set(selected.map { $0.deletingLastPathComponent().standardizedFileURL }).count == 1 else {
            uploadStatus = "Select files from one FlySight session only."
            return
        }
        let selectedNames = Set(selected.map { $0.lastPathComponent.uppercased() })
        guard selectedNames.contains("TRACK.CSV") || selectedNames.contains("TRACK.GPX") else {
            uploadStatus = "Select TRACK.CSV or TRACK.GPX from this session."
            return
        }
        guard !selectedNames.contains("SENSOR.CSV") || selectedNames.contains("TRACK.CSV") else {
            uploadStatus = "SENSOR.CSV must be selected together with TRACK.CSV."
            return
        }
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

    private func readDirectory(_ path: String) {
        currentDirectory = path.isEmpty ? "/" : path
        isListing = true
        files = []
        bluetooth.listDirectory(path: currentDirectory) { result in
            isListing = false
            switch result {
            case .success(let entries):
                files = entries
            case .failure(let error):
                transferSaveError = error.localizedDescription
            }
        }
    }

    private func download(_ file: FlySightBLEClient.FlySightFile) {
        downloadingName = file.path
        bluetooth.downloadFile(path: file.path, expectedSize: file.size) { result in
            downloadingName = nil
            switch result {
            case .success(let data):
                do {
                    let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    let root = documents.appendingPathComponent("FlySight Imports", isDirectory: true)
                    let relativeFolders = file.path.split(separator: "/").dropLast().map(String.init)
                    let safeFolders = relativeFolders.map { component in
                        String(component.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." ? $0 : "_" })
                    }.filter { !$0.isEmpty && $0 != "." && $0 != ".." }
                    let folder = safeFolders.reduce(root) { $0.appendingPathComponent($1, isDirectory: true) }
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
