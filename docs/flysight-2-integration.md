# FlySight 2 integration

## Current web import

The web logbook imports `TRACK.CSV` (or GPX) and optionally `SENSOR.CSV` together. Sensor metadata is read from the FlySight `$VAR`, `$COL`, `$UNIT`, and `$DATA` sections. The current sensor import stores per-stream sample counts and per-column minimum, maximum, and mean values; it intentionally does not persist every high-frequency sensor sample yet.

## Native iOS Bluetooth prototype

The native source is in `native/ios/`. It is a source prototype, not yet a complete Xcode project or installable app.

- `FlySightBLEClient.swift`: CoreBluetooth discovery, bonding trigger, GNSS telemetry, battery/mode reads, directory listing and file reads.
- `FlySightConnectionView.swift`: SwiftUI device picker, telemetry display, file browser, CSV download and iOS share sheet.
- `FlySightLogbookApp.swift`: SwiftUI app entry point.
- `Info.plist.fragment`: Bluetooth privacy usage description to merge into the app's Info.plist.

### File transfer protocol implemented in the prototype

Based on the FlySight 2 firmware BLE developer documentation:

1. Pair/bond first by connecting and attempting a secure read of `FT_Packet_In`.
2. File operations require Idle/Sleep mode (LED off); the firmware mode enum identifies Sleep as value `0`. The client refuses file operations when the reported mode is not `0`.
3. Subscribe to `FT_Packet_Out` notifications.
4. List a directory using command `0x05`; parse `0x11` file-info packets until the null first filename byte marks the end.
5. Read a file using command `0x02`, little-endian zero offset and stride multipliers, and a null-terminated path.
6. For every `0x10` data packet, append its payload and return `0x12` plus the packet counter. A packet with no data bytes marks EOF; it is acknowledged too.
7. Treat `0xf0` as command rejection and `0xf1` as command acknowledgement. The prototype also applies a 30-second transfer timeout and supports `0xff` cancellation.
8. Save downloaded files in the app's Documents directory and expose them through the iOS share sheet. The source files on the FlySight are never modified or deleted.

The protocol documentation specifies Go-Back-N with a window of eight packets and 242-byte frames. The current client acknowledges received packets individually; retransmission behavior, negotiated MTU edge cases, and long-transfer reliability still require validation against hardware and firmware.

## Planned import workflow

1. User explicitly connects and pairs the FlySight 2.
2. User switches the FlySight to Idle mode (LED off).
3. App lists the device directory and user selects `TRACK.CSV` and `SENSOR.CSV`.
4. App downloads the files without modifying or deleting the originals.
5. The downloaded files are shared to the web logbook's existing file import UI; direct in-app handoff into the web app remains to be implemented.
6. The user reviews the track and sensor summaries before attaching them to a jump.

## Known gaps before release

- Create and sign a real iOS Xcode project and configure the Bluetooth usage string.
- Validate secure pairing, device discovery and mode values on actual iPhone/FlySight hardware.
- Confirm directory path conventions and packet offsets using real device responses.
- Implement robust Go-Back-N retransmission/window handling and MTU negotiation; test interrupted and large downloads.
- Connect downloaded file handoff to the existing web app import flow.
- Add automated iOS build/device tests.

## Safety and data integrity

- BLE pairing remains user-initiated and encrypted.
- The app does not delete or write source files to the FlySight.
- Never infer a deployment event solely from an unvalidated sensor heuristic.
- Preserve original source files or a recoverable copy before transformations.
- Clearly distinguish imported measurements from calculated estimates.
- Do not claim live IMU/barometer/magnetometer streaming until those data channels and their firmware support have been verified on a real device.
