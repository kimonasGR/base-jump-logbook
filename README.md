# BASE Jump Logbook

Private, mobile-first BASE jumping logbook.

## Status

The repository contains a private web logbook prototype with authenticated API routes, account-scoped cloud snapshot sync, local recovery backups, and FlySight GPX/CSV import. It is **not yet production-ready**. Native iOS Bluetooth source includes device discovery, telemetry, a basic directory/file-read flow, packet sequencing, and transfer keep-alive. It remains a prototype: no installable Xcode project or physical-device validation yet.

Photos and videos remain local to the device. Imported FlySight track and sensor summaries are included in the cloud-synced jump record.

## Requirements

- Node.js 20 or newer
- PostgreSQL (Neon recommended)

## Local setup

```bash
npm install
cp .env.example .env
npm test
npm start
```

Configure `DATABASE_URL`, `NEON_AUTH_ISSUER`, `NEON_AUTH_JWKS_URL`, and `OPENAI_API_KEY` in your local `.env` or deployment environment. Never commit real credentials.

## FlySight 2

The web app can import `TRACK.CSV` and `SENSOR.CSV` together. Sensor streams currently produce sample counts and basic measurement summaries.

Native iOS prototype source is in `native/ios/`:
- `FlySightLogbookApp.swift`: SwiftUI app entry point.
- `FlySightConnectionView.swift`: discovery and telemetry prototype UI.
- `FlySightBLEClient.swift`: CoreBluetooth discovery, secure connection setup, battery/mode reads, GNSS notifications, device directory listing and CSV file downloads.
- `Info.plist.fragment`: Bluetooth privacy usage description to merge into the app's Info.plist.

These files are source components, not a complete Xcode project. The current file-transfer prototype lists device files and downloads selected files to the app's Documents directory; it does not modify or delete files on the FlySight. Go-Back-N receive sequencing and 15-second keep-alive are implemented, but retransmission behavior, MTU edge cases, interrupted transfers, and physical-device compatibility still require testing. The iOS Swift source is type-checked in GitHub Actions. See [the integration plan](docs/flysight-2-integration.md).

## Quality checks

GitHub Actions runs `npm test` and type-checks the native iOS Swift sources against the iOS Simulator SDK on pushes to `main` and pull requests.

## Deployment

The project includes a Vercel catch-all API function and `vercel.json`. Connect this repository to the existing Vercel project only after reviewing the build and environment configuration. Do not create a replacement database or Vercel project.

## Safety and privacy

Jump records are private user data. All data routes must enforce authenticated ownership. Voice extraction creates a reviewable draft and must never save a jump without explicit user confirmation. Track-derived opening metrics are estimates and must be reviewed by the user; they are not safety-critical measurements.
