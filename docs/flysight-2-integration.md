# FlySight 2 integration

## Current web import

The web logbook imports `TRACK.CSV` (or GPX) and optionally `SENSOR.CSV` together. Sensor metadata is read from the FlySight `$VAR`, `$COL`, `$UNIT`, and `$DATA` sections. The current sensor import stores per-stream sample counts and per-column minimum, maximum, and mean values; it intentionally does not persist every high-frequency sensor sample yet.

## Native iOS Bluetooth prototype

The native source and XcodeGen project definition are in `native/ios/`. Generate the Xcode project with `brew install xcodegen && cd native/ios && xcodegen generate`. Open `BASEJumpLogbook.xcodeproj` in Xcode, select a signing team, then build/run on a paired iPhone.

- `FlySightBLEClient.swift`: CoreBluetooth discovery, bonding trigger, GNSS telemetry, battery/mode reads, directory listing and file reads.
- `FlySightConnectionView.swift`: SwiftUI device picker, telemetry display, file browser, CSV download and iOS share sheet.
- `FlySightLogbookApp.swift`: SwiftUI app entry point.
- `project.yml`: XcodeGen project definition, iOS 17 target and generated Bluetooth privacy usage description.
- `Info.plist.fragment`: reference Bluetooth privacy usage description (the generated project configures this automatically).

### File transfer protocol implemented in the prototype

Based on the FlySight 2 firmware BLE developer documentation:

1. Pair/bond first by connecting and attempting a secure read of `FT_Packet_In`.
2. File operations require Idle/Sleep mode (LED off); the firmware mode enum identifies Sleep as value `0`. The client refuses file operations when the reported mode is not `0`.
3. Subscribe to `FT_Packet_Out` notifications.
4. List a directory using command `0x05`; parse `0x11` file-info packets until the null first filename byte marks the end.
5. Read a file using command `0x02`, little-endian zero offset and stride multipliers, and a null-terminated path.
6. For every `0x10` data packet, append its payload and return `0x12` plus the packet counter. A packet with no data bytes marks EOF; it is acknowledged too.
7. Treat `0xf0` as command rejection and `0xf1` as command acknowledgement. The prototype also applies a 30-second transfer timeout and supports `0xff` cancellation.
8. Save downloaded files in the app's Documents directory. The native screen lets the user select `TRACK.CSV` and `SENSOR.CSV` together and share both files in one share-sheet action. The user then selects both in the web logbook's existing multi-file import control. The source files on the FlySight are never modified or deleted.

The protocol documentation specifies Go-Back-N with a window of eight packets and 242-byte frames. The client tracks sequential receive counters, re-acknowledges duplicates still inside an eight-packet receive window without appending them twice, leaves future/out-of-window packets unacknowledged, and sends a 15-second keep-alive. Directory completion and failure now stop both transfer timers. This is not yet a proven full Go-Back-N implementation: counter wrap, older duplicates, retransmission timing, negotiated MTU edge cases, and long-transfer reliability still require validation against hardware and firmware.

## Planned import workflow

1. User unplugs USB, switches on the FlySight 2, double-presses its button to open the pairing window, then connects from the iOS app.
2. User switches the FlySight to Idle mode (LED off).
3. App lists the device directory. The user browses the date and session folders, then selects `TRACK.CSV` and optionally `SENSOR.CSV` from the same session.
4. App downloads the files into matching local date/session folders without modifying or deleting the originals.
5. In the signed-in web logbook, create a one-time FlySight token from Settings. In the iOS app, paste the token (the production API URL is pre-filled) and upload the selected files over HTTPS in 256 KiB chunks. The server verifies the declared SHA-256 before making files visible to the same account.
6. In the web logbook, open a new jump and use **Load FlySight inbox**. The browser downloads and independently verifies every chunk, passes the source files into the existing TRACK/SENSOR import parser, and shows the track and sensor summary for review. The user saves the jump only after checking the draft.
7. Delete the temporary inbox handoff from the jump form after import; the saved jump retains its imported track data and source-file fingerprints.

## Known gaps before release

- Configure Apple signing/team and install the generated app on a physical iPhone.
- Validate secure pairing, device discovery, directory attribute flags, mode values and packet offsets on actual iPhone/FlySight hardware.
- Validate Go-Back-N retransmission/window handling, counter wrap, MTU negotiation and interrupted/large downloads on hardware. The current implementation is bounded and duplicate-aware, but is not yet a proven full Go-Back-N implementation.
- Validate the complete upload → inbox → browser verification → import-review workflow using a signed-in account.
- Add automated iOS build/device tests.

## Safety and data integrity

- BLE pairing remains user-initiated and encrypted.
- The app does not delete or write source files to the FlySight.
- Never infer a deployment event solely from an unvalidated sensor heuristic.
- Preserve original source files or a recoverable copy before transformations.
- Clearly distinguish imported measurements from calculated estimates.
- Do not claim live IMU/barometer/magnetometer streaming until those data channels and their firmware support have been verified on a real device.


## Secure native-to-web handoff foundation

The API now supports short-lived (10-minute), random upload-only handoff tokens. Only a SHA-256 digest is stored in PostgreSQL; the token itself is returned once to the authenticated browser and is never a Neon Auth credential. The native uploader can send only TRACK.CSV, SENSOR.CSV or TRACK.GPX, split into 256 KiB chunks, with a 15 MiB per-file ceiling and declared SHA-256 metadata. The authenticated web account can list completed files and retrieve individual chunks; every read is scoped to the owning user. Expired sessions and files cascade-delete through the migration schema.

Apply `migrations/002_flysight_handoff.sql` to the existing Neon database before enabling this flow. The native iOS screen and web Settings/import form now expose the one-time token, chunk upload, and import-inbox workflow. The optional iOS share sheet remains available as a manual fallback.
