# FlySight 2 integration

## Current web import

The web logbook imports `TRACK.CSV` (or GPX) and optionally `SENSOR.CSV` together. Sensor metadata is read from the FlySight `$VAR`, `$COL`, `$UNIT`, and `$DATA` sections. The current sensor import stores per-stream sample counts and per-column minimum, maximum, and mean values; it intentionally does not persist every high-frequency sensor sample yet.

## Native Bluetooth integration

A normal iOS browser page cannot be treated as a reliable Web Bluetooth client. Direct FlySight 2 access on iPhone therefore requires a native iOS host (for example, a Capacitor app with a CoreBluetooth bridge) and a separately tested BLE transport.

The FlySight 2 BLE developer documentation describes secure BLE bonding, a File Transfer service available in Idle Mode, directory listing and file reads over the packet protocol, and a Sensor Data service for live GNSS measurements in Active/Start modes.

The file-transfer transport must implement notification subscription, packet sequencing, ACK/NAK handling, end-of-file detection, cancellation, and the device's inactivity keep-alive. It must not attempt file-system reads while the device is actively logging or in USB mode.

## Planned import workflow

1. User explicitly connects and pairs the FlySight 2.
2. App reads the device directory in Idle Mode.
3. App identifies and downloads the matching `TRACK.CSV` and `SENSOR.CSV` files.
4. Both files pass through the same parsers used by manual import.
5. The user reviews the track and sensor summaries before attaching them to a jump.
6. Disconnect cleanly; never delete or modify source files on the device.

## Safety and data integrity

- BLE pairing must remain user-initiated and encrypted.
- Never infer a deployment event solely from an unvalidated sensor heuristic.
- Preserve original source files or a recoverable copy before any future transformations.
- Clearly distinguish imported measurements from calculated estimates.
- Do not claim live IMU/barometer/magnetometer streaming until those data channels and their firmware support have been verified on a real device.
