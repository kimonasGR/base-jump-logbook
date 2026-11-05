import Foundation
import Combine
@preconcurrency import CoreBluetooth

/// CoreBluetooth transport for FlySight 2. This is a native iOS component;
/// it is not available from Safari/Web Bluetooth.
@MainActor
final class FlySightBLEClient: NSObject, ObservableObject {
    enum ConnectionState: Equatable {
        case unavailable, poweredOff, scanning, connecting, pairingRequired, connected, disconnected(String)
    }

    struct GNSSSample: Equatable {
        let timeOfWeekMs: UInt32?
        let longitude: Double?
        let latitude: Double?
        let altitudeMslMeters: Double?
        let velocityNorthMps: Double?
        let velocityEastMps: Double?
        let velocityDownMps: Double?
        let horizontalAccuracyMeters: Double?
        let verticalAccuracyMeters: Double?
        let speedAccuracyMps: Double?
        let satellites: UInt8?
    }

    @Published private(set) var state: ConnectionState = .unavailable
    @Published private(set) var deviceName: String?
    @Published private(set) var batteryPercent: Int?
    @Published private(set) var deviceMode: UInt8?
    @Published private(set) var latestGNSS: GNSSSample?
    @Published private(set) var discoveredDevices: [FlySightDevice] = []
    @Published private(set) var transferStatus: String = ""
    @Published private(set) var transferProgress: Double = 0

    struct FlySightFile: Identifiable, Equatable {
        let name: String
        let path: String
        let size: UInt32
        let attributes: UInt8
        var id: String { path }
        /// FlySight uses the FAT directory attribute bit (0x10).
        var isDirectory: Bool { attributes & 0x10 != 0 }
    }

    enum FileTransferError: LocalizedError {
        case notConnected, idleModeRequired, missingCharacteristic, malformedPacket, deviceRejected(UInt8), timedOut, cancelled, transferInProgress, fileTooLarge, sizeMismatch, writeQueueFull
        var errorDescription: String? {
            switch self {
            case .notConnected: return "Connect to FlySight 2 first."
            case .idleModeRequired: return "File transfer is only available in FlySight Idle mode. Switch the device to Idle (LED off)."
            case .missingCharacteristic: return "FlySight file-transfer characteristics are unavailable."
            case .malformedPacket: return "FlySight returned a malformed file-transfer packet."
            case .deviceRejected(let command): return String(format: "FlySight rejected file-transfer command 0x%02X.", command)
            case .timedOut: return "FlySight file transfer timed out."
            case .cancelled: return "File transfer was cancelled."
            case .transferInProgress: return "Another FlySight file operation is already in progress."
            case .fileTooLarge: return "This file exceeds the 15 MB import limit."
            case .sizeMismatch: return "Downloaded file size does not match the directory listing."
            case .writeQueueFull: return "Bluetooth is not accepting writes quickly enough. The transfer was stopped to avoid losing data."
            }
        }
    }

    struct FlySightDevice: Identifiable {
        let peripheral: CBPeripheral
        let name: String
        var id: UUID { peripheral.identifier }
    }

    private let fileService = CBUUID(string: "00000000-cc7a-482a-984a-7f2ed5b3e58f")
    private let sensorService = CBUUID(string: "00000001-cc7a-482a-984a-7f2ed5b3e58f")
    private let stateService = CBUUID(string: "00000003-cc7a-482a-984a-7f2ed5b3e58f")
    private let batteryService = CBUUID(string: "180F")
    private let filePacketOut = CBUUID(string: "00000001-8e22-4541-9d4c-21edae82ed19")
    private let filePacketIn = CBUUID(string: "00000002-8e22-4541-9d4c-21edae82ed19")
    private let gnssMeasurement = CBUUID(string: "00000000-8e22-4541-9d4c-21edae82ed19")
    private let deviceModeCharacteristic = CBUUID(string: "00000005-8e22-4541-9d4c-21edae82ed19")
    private let batteryLevel = CBUUID(string: "2A19")

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var characteristics: [CBUUID: CBCharacteristic] = [:]
    private struct PendingBLEWrite {
        let data: Data
        let characteristic: CBCharacteristic
    }
    private var pendingBLEWrites: [PendingBLEWrite] = []
    private let maximumPendingBLEWrites = 128
    private var pendingCommand: UInt8?
    private var commandCompletion: ((Result<Void, Error>) -> Void)?
    private var directoryEntries: [FlySightFile] = []
    private var listingPath = "/"
    private var directoryCompletion: ((Result<[FlySightFile], Error>) -> Void)?
    private var downloadBuffer = Data()
    private var downloadExpectedSize: UInt32 = 0
    private var downloadCompletion: ((Result<Data, Error>) -> Void)?
    private var downloadPath: String?
    private var transferTimeout: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?
    private var scanTimeoutTask: Task<Void, Never>?
    private var expectedDownloadCounter: UInt8 = 0
    private var recentlyAcknowledgedCounters: [UInt8] = []
    private let maximumImportFileSize = 15 * 1024 * 1024

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func startScan() {
        guard central.state == .poweredOn else { return }
        scanTimeoutTask?.cancel()
        discoveredDevices = []
        state = .scanning
        // FlySight 2 advertises its manufacturer ID (0x09DB); its custom
        // services are discovered after connection, not necessarily advertised.
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        // Bound scanning to avoid leaving Bluetooth discovery active indefinitely.
        scanTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            guard !Task.isCancelled, let self, self.state == .scanning else { return }
            self.central.stopScan()
            self.state = .disconnected("No FlySight 2 found. Try scanning again.")
            self.scanTimeoutTask = nil
        }
    }

    func stopScan() {
        scanTimeoutTask?.cancel()
        scanTimeoutTask = nil
        central.stopScan()
        if state == .scanning { state = .disconnected("Scan stopped.") }
    }

    func connect(to peripheral: CBPeripheral) {
        guard self.peripheral?.state != .connected,
              state != .connecting else { return }
        stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        state = .connecting
        central.connect(peripheral, options: nil)
    }

    func disconnect() {
        guard let peripheral else { return }
        pendingBLEWrites.removeAll(keepingCapacity: false)
        stopTransferTimers()
        if directoryCompletion != nil {
            finishDirectory(.failure(FileTransferError.cancelled))
        } else if downloadCompletion != nil {
            finishTransfer(.failure(FileTransferError.cancelled))
        }
        central.cancelPeripheralConnection(peripheral)
    }

    /// Lists a device directory. Must be called while FlySight is in Idle mode.
    func listDirectory(path: String = "/", completion: @escaping (Result<[FlySightFile], Error>) -> Void) {
        guard state == .connected, peripheral != nil else { completion(.failure(FileTransferError.notConnected)); return }
        guard !transferIsActive else { completion(.failure(FileTransferError.transferInProgress)); return }
        guard deviceMode == 0 else { completion(.failure(FileTransferError.idleModeRequired)); return }
        guard let tx = characteristics[filePacketIn], characteristics[filePacketOut] != nil else { completion(.failure(FileTransferError.missingCharacteristic)); return }
        directoryEntries = []
        listingPath = path.hasPrefix("/") ? path : "/" + path
        directoryCompletion = completion
        beginTimeout()
        beginKeepAlive()
        sendCommand(0x05, path: path, characteristic: tx)
    }

    /// Reads a file without modifying or deleting the source on the FlySight.
    func downloadFile(path: String, expectedSize: UInt32 = 0, completion: @escaping (Result<Data, Error>) -> Void) {
        guard state == .connected, peripheral != nil else { completion(.failure(FileTransferError.notConnected)); return }
        guard !transferIsActive else { completion(.failure(FileTransferError.transferInProgress)); return }
        guard deviceMode == 0 else { completion(.failure(FileTransferError.idleModeRequired)); return }
        guard expectedSize <= UInt32(maximumImportFileSize) else { completion(.failure(FileTransferError.fileTooLarge)); return }
        guard let tx = characteristics[filePacketIn], characteristics[filePacketOut] != nil else { completion(.failure(FileTransferError.missingCharacteristic)); return }
        downloadBuffer = Data()
        expectedDownloadCounter = 0
        recentlyAcknowledgedCounters = []
        downloadExpectedSize = expectedSize
        downloadCompletion = completion
        downloadPath = path
        transferProgress = 0
        transferStatus = "Requesting " + path
        beginTimeout()
        beginKeepAlive()
        var command = Data([0x02])
        command.append(contentsOf: [UInt8](repeating: 0, count: 8))
        command.append(contentsOf: path.utf8)
        command.append(0)
        enqueueWrite(command, characteristic: tx)
    }

    func cancelOperation() {
        guard let tx = characteristics[filePacketIn], transferIsActive else { return }
        // Discard stale data/keep-alive frames before placing the cancel command.
        pendingBLEWrites.removeAll(keepingCapacity: false)
        enqueueWrite(Data([0xff]), characteristic: tx)
        finishTransfer(.failure(FileTransferError.cancelled), preservePendingWrites: true)
    }

    private var transferIsActive: Bool { directoryCompletion != nil || downloadCompletion != nil || commandCompletion != nil }

    private func sendCommand(_ opcode: UInt8, path: String, characteristic: CBCharacteristic) {
        var packet = Data([opcode])
        packet.append(contentsOf: path.utf8)
        packet.append(0)
        enqueueWrite(packet, characteristic: characteristic)
    }

    /// CoreBluetooth applies backpressure to writes without response. Keep protocol
    /// frames ordered and drain them only when the peripheral reports capacity.
    private func enqueueWrite(_ data: Data, characteristic: CBCharacteristic) {
        guard let peripheral, peripheral.state == .connected else { return }
        if pendingBLEWrites.isEmpty && peripheral.canSendWriteWithoutResponse {
            peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
            return
        }
        guard pendingBLEWrites.count < maximumPendingBLEWrites else {
            pendingBLEWrites.removeAll(keepingCapacity: false)
            if directoryCompletion != nil {
                finishDirectory(.failure(FileTransferError.writeQueueFull))
            } else if transferIsActive {
                finishTransfer(.failure(FileTransferError.writeQueueFull))
            }
            return
        }
        pendingBLEWrites.append(PendingBLEWrite(data: data, characteristic: characteristic))
    }

    private func flushPendingWrites(for peripheral: CBPeripheral) {
        guard self.peripheral === peripheral else { return }
        while peripheral.canSendWriteWithoutResponse && !pendingBLEWrites.isEmpty {
            let next = pendingBLEWrites.removeFirst()
            peripheral.writeValue(next.data, for: next.characteristic, type: .withoutResponse)
        }
    }

    private func beginKeepAlive() {
        keepAliveTask?.cancel()
        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled else { return }
                await MainActor.run { self?.sendKeepAlive() }
            }
        }
    }

    private func sendKeepAlive() {
        guard transferIsActive, let tx = characteristics[filePacketIn], peripheral != nil else { return }
        enqueueWrite(Data([0xfe]), characteristic: tx)
    }

    private func stopTransferTimers() {
        transferTimeout?.cancel()
        transferTimeout = nil
        keepAliveTask?.cancel()
        keepAliveTask = nil
    }

    private func beginTimeout() {
        transferTimeout?.cancel()
        transferTimeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.finishTransfer(.failure(FileTransferError.timedOut)) }
        }
    }

    private func finishTransfer(_ result: Result<Data, Error>, preservePendingWrites: Bool = false) {
        stopTransferTimers()
        // On failure, queued frames belong to the expired operation and must
        // never leak into a later transfer. On EOF/cancel, retain protocol
        // ACK/cancel frames until CoreBluetooth has capacity to send them.
        if !preservePendingWrites {
            pendingBLEWrites.removeAll(keepingCapacity: false)
        }
        if let completion = downloadCompletion {
            let completedPath = downloadPath ?? "file"
            downloadCompletion = nil
            directoryCompletion = nil
            downloadPath = nil
            switch result {
            case .success: transferStatus = "Downloaded " + completedPath
            case .failure(let error): transferStatus = error.localizedDescription
            }
            completion(result)
        } else if case .failure(let error) = result, let completion = directoryCompletion {
            directoryCompletion = nil
            transferStatus = error.localizedDescription
            completion(.failure(error))
        }
    }

    private func finishDirectory(_ result: Result<[FlySightFile], Error>) {
        stopTransferTimers()
        // Directory listings have no final data ACK to preserve. Drop queued
        // commands/keep-alives so they cannot run during a later file operation.
        pendingBLEWrites.removeAll(keepingCapacity: false)
        let completion = directoryCompletion
        directoryCompletion = nil
        if case .success(let files) = result { transferStatus = "Found \(files.count) files" }
        if case .failure(let error) = result { transferStatus = error.localizedDescription }
        completion?(result)
    }

    private func handleFilePacket(_ data: Data) {
        guard let opcode = data.first else { return }
        switch opcode {
        case 0xf1:
            guard data.count >= 2 else { return }
            if let pending = pendingCommand, pending == data[1] {
                pendingCommand = nil
                commandCompletion?(.success(()))
                commandCompletion = nil
            }
        case 0xf0:
            guard data.count >= 2 else { return }
            let error = FileTransferError.deviceRejected(data[1])
            if directoryCompletion != nil { finishDirectory(.failure(error)) }
            else { finishTransfer(.failure(error)) }
        case 0x11:
            guard data.count >= 24, directoryCompletion != nil else { return }
            beginTimeout()
            let nameBytes = data.subdata(in: 11..<24)
            let name = String(decoding: nameBytes.prefix { $0 != 0 }, as: UTF8.self)
            if name.isEmpty { finishDirectory(.success(directoryEntries)); return }
            let size = data.subdata(in: 2..<6).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
            let attributes = data[10]
            let parent = listingPath == "/" ? "" : listingPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let fullPath = parent.isEmpty ? "/" + name : "/" + parent + "/" + name
            directoryEntries.append(FlySightFile(name: name, path: fullPath, size: size, attributes: attributes))
        case 0x10:
            guard data.count >= 2, downloadCompletion != nil else { return }
            let counter = data[1]
            if recentlyAcknowledgedCounters.contains(counter) {
                // Re-acknowledge any duplicate still inside the receive window.
                // Never append duplicate payload bytes to the downloaded file.
                if let tx = characteristics[filePacketIn] {
                    enqueueWrite(Data([0x12, counter]), characteristic: tx)
                }
                return
            }
            guard counter == expectedDownloadCounter else {
                // Future/out-of-window packets remain unacknowledged so the
                // FlySight sender can retry from its current Go-Back-N base.
                return
            }
            if let tx = characteristics[filePacketIn] {
                enqueueWrite(Data([0x12, counter]), characteristic: tx)
            }
            recentlyAcknowledgedCounters.append(counter)
            if recentlyAcknowledgedCounters.count > 8 {
                recentlyAcknowledgedCounters.removeFirst(recentlyAcknowledgedCounters.count - 8)
            }
            expectedDownloadCounter = counter &+ 1
            if data.count == 2 {
                let result = downloadBuffer
                if downloadExpectedSize > 0 && UInt32(result.count) != downloadExpectedSize {
                    finishTransfer(.failure(FileTransferError.sizeMismatch))
                } else {
                    finishTransfer(.success(result), preservePendingWrites: true)
                }
                return
            }
            let payload = data.subdata(in: 2..<data.count)
            let nextSize = downloadBuffer.count + payload.count
            guard nextSize <= maximumImportFileSize,
                  downloadExpectedSize == 0 || nextSize <= Int(downloadExpectedSize) else {
                finishTransfer(.failure(FileTransferError.fileTooLarge))
                return
            }
            downloadBuffer.append(payload)
            if downloadExpectedSize > 0 {
                transferProgress = min(1, Double(downloadBuffer.count) / Double(downloadExpectedSize))
            }
            beginTimeout()
        default: break
        }
    }

    private func discoverCharacteristics() {
        guard let peripheral else { return }
        for service in peripheral.services ?? [] { peripheral.discoverCharacteristics(nil, for: service) }
    }

    private func decodeGNSS(_ data: Data) -> GNSSSample? {
        guard let mask = data.first else { return nil }
        var offset = 1
        func take<T: FixedWidthInteger>(_ type: T.Type) -> T? {
            let count = MemoryLayout<T>.size
            guard offset + count <= data.count else { return nil }
            let value = data[offset..<(offset + count)].withUnsafeBytes { $0.loadUnaligned(as: T.self) }.littleEndian
            offset += count
            return value
        }
        let tow = mask & 0x80 != 0 ? take(UInt32.self) : nil
        let lon = mask & 0x20 != 0 ? take(Int32.self) : nil
        let lat = mask & 0x20 != 0 ? take(Int32.self) : nil
        let hmsl = mask & 0x20 != 0 ? take(Int32.self) : nil
        let north = mask & 0x10 != 0 ? take(Int32.self) : nil
        let east = mask & 0x10 != 0 ? take(Int32.self) : nil
        let down = mask & 0x10 != 0 ? take(Int32.self) : nil
        let hAcc = mask & 0x08 != 0 ? take(UInt32.self) : nil
        let vAcc = mask & 0x08 != 0 ? take(UInt32.self) : nil
        let sAcc = mask & 0x08 != 0 ? take(UInt32.self) : nil
        let sv = mask & 0x04 != 0 ? take(UInt8.self) : nil
        return GNSSSample(
            timeOfWeekMs: tow,
            longitude: lon.map { Double($0) / 1e7 },
            latitude: lat.map { Double($0) / 1e7 },
            altitudeMslMeters: hmsl.map { Double($0) / 1000 },
            velocityNorthMps: north.map { Double($0) / 1000 },
            velocityEastMps: east.map { Double($0) / 1000 },
            velocityDownMps: down.map { Double($0) / 1000 },
            horizontalAccuracyMeters: hAcc.map { Double($0) / 1000 },
            verticalAccuracyMeters: vAcc.map { Double($0) / 1000 },
            speedAccuracyMps: sAcc.map { Double($0) / 1000 },
            satellites: sv
        )
    }
}

extension FlySightBLEClient: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state != .poweredOn {
            scanTimeoutTask?.cancel()
            scanTimeoutTask = nil
            pendingBLEWrites.removeAll(keepingCapacity: false)
            if directoryCompletion != nil {
                finishDirectory(.failure(FileTransferError.notConnected))
            } else if downloadCompletion != nil {
                finishTransfer(.failure(FileTransferError.notConnected))
            }
        }
        switch central.state {
        case .poweredOn: state = .disconnected("Bluetooth ready")
        case .poweredOff: state = .poweredOff
        case .unauthorized, .unsupported: state = .unavailable
        default: state = .unavailable
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let manufacturer = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data
        // Manufacturer payload after Apple's company identifier: DB 09 + status.
        guard let manufacturer, manufacturer.count >= 3,
              manufacturer[0] == 0xDB, manufacturer[1] == 0x09 else { return }
        let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? "FlySight 2"
        if !discoveredDevices.contains(where: { $0.id == peripheral.identifier }) {
            discoveredDevices.append(FlySightDevice(peripheral: peripheral, name: name))
        }
        deviceName = name
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        state = .connected
        peripheral.discoverServices([fileService, sensorService, stateService, batteryService])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard self.peripheral === peripheral else { return }
        self.peripheral = nil
        characteristics.removeAll()
        state = .disconnected(error?.localizedDescription ?? "Connection failed")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        // Ignore late callbacks from a peripheral that is no longer active.
        guard self.peripheral === peripheral else { return }
        self.peripheral = nil
        characteristics.removeAll()
        pendingBLEWrites.removeAll(keepingCapacity: false)
        if directoryCompletion != nil { finishDirectory(.failure(FileTransferError.cancelled)) }
        if downloadCompletion != nil { finishTransfer(.failure(FileTransferError.cancelled)) }
        state = .disconnected(error?.localizedDescription ?? "Disconnected")
    }
}

extension FlySightBLEClient: CBPeripheralDelegate {
    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        flushPendingWrites(for: peripheral)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil else { state = .disconnected(error!.localizedDescription); return }
        discoverCharacteristics()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else { return }
        for characteristic in service.characteristics ?? [] {
            characteristics[characteristic.uuid] = characteristic
            if characteristic.uuid == filePacketIn {
                // Reading this encrypted characteristic triggers iOS pairing on first use.
                peripheral.readValue(for: characteristic)
            } else if characteristic.uuid == gnssMeasurement || characteristic.uuid == batteryLevel || characteristic.uuid == deviceModeCharacteristic {
                peripheral.setNotifyValue(true, for: characteristic)
                if characteristic.properties.contains(.read) { peripheral.readValue(for: characteristic) }
            } else if characteristic.uuid == filePacketOut {
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            if characteristic.uuid == filePacketIn {
                state = .pairingRequired
            }
            return
        }
        guard let data = characteristic.value else { return }
        if characteristic.uuid == filePacketOut { handleFilePacket(data) }
        if characteristic.uuid == gnssMeasurement { latestGNSS = decodeGNSS(data) }
        if characteristic.uuid == batteryLevel, let level = data.first { batteryPercent = Int(level) }
        if characteristic.uuid == deviceModeCharacteristic, let mode = data.first { deviceMode = mode }
        if characteristic.uuid == filePacketIn { state = .connected }
    }
}
