import Foundation
import CoreBluetooth

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

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func startScan() {
        guard central.state == .poweredOn else { return }
        discoveredDevices = []
        state = .scanning
        // FlySight 2 advertises its manufacturer ID (0x09DB); its custom
        // services are discovered after connection, not necessarily advertised.
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    func stopScan() { central.stopScan() }

    func connect(to peripheral: CBPeripheral) {
        stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        state = .connecting
        central.connect(peripheral, options: nil)
    }

    func disconnect() {
        guard let peripheral else { return }
        central.cancelPeripheralConnection(peripheral)
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
        state = .disconnected(error?.localizedDescription ?? "Connection failed")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        characteristics.removeAll()
        state = .disconnected(error?.localizedDescription ?? "Disconnected")
    }
}

extension FlySightBLEClient: CBPeripheralDelegate {
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
        if characteristic.uuid == gnssMeasurement { latestGNSS = decodeGNSS(data) }
        if characteristic.uuid == batteryLevel, let level = data.first { batteryPercent = Int(level) }
        if characteristic.uuid == deviceModeCharacteristic, let mode = data.first { deviceMode = Int(mode) }
        if characteristic.uuid == filePacketIn { state = .connected }
    }
}
