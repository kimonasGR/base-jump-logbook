# BASE Jump Logbook

Private, mobile-first BASE jumping logbook.

## Status

The repository contains a private, mobile-first web logbook with authenticated API routes, account-scoped cloud snapshot sync, local recovery backups, FlySight GPX/CSV import, and a native iOS companion source project. The native companion includes BLE discovery, pairing flow, telemetry, directory listing, file downloads, and secure chunked upload to the signed-in web account's import inbox. The iOS Simulator build and Swift source checks run in CI. A signed physical-device build and end-to-end validation with an actual FlySight 2 remain release gates.

Jump records and FlySight track data sync to the private Neon account. Photos and videos can be stored in the private `base-jump-media` Neon Object Storage bucket; uploads are limited to 3 MB per file. The private bucket, media metadata table, and production storage credentials are provisioned. Cloud media uploads are implemented; a real signed-in upload/view/delete acceptance test remains outstanding.

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

Configure `DATABASE_URL`, `NEON_AUTH_ISSUER`, `NEON_AUTH_JWKS_URL`, and `OPENAI_API_KEY` in your local `.env` or deployment environment. To enable private media uploads, also set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, and `NEON_STORAGE_BUCKET` using credentials scoped to the Neon `main` branch. The bucket is private; the API returns short-lived signed download URLs. Never commit real credentials.

## Database migrations

Database migrations are maintained in `migrations/` and have been applied to the existing Neon production database. Do not create a replacement database. Binary media files are stored in the private Neon Object Storage bucket.

## FlySight 2

The web app can import `TRACK.CSV` and `SENSOR.CSV` together. Sensor streams currently produce sample counts and basic measurement summaries.

Native iOS prototype source is in `native/ios/`:
- `FlySightLogbookApp.swift`: SwiftUI app entry point.
- `FlySightConnectionView.swift`: discovery and telemetry prototype UI.
- `FlySightBLEClient.swift`: CoreBluetooth discovery, secure connection setup, battery/mode reads, GNSS notifications, device directory listing and CSV file downloads.
- `Info.plist.fragment`: Bluetooth privacy usage description to merge into the app's Info.plist.

An XcodeGen project definition is provided at `native/ios/project.yml`; generate the `.xcodeproj` with `brew install xcodegen && cd native/ios && xcodegen generate`. GitHub Actions builds the generated app for the iOS Simulator. The current file-transfer prototype lists device files and downloads selected files to the app's Documents directory; it can share `TRACK.CSV` and `SENSOR.CSV` together to the web import flow. Imported source files are fingerprinted with SHA-256 for provenance and duplicate-source recognition. The app does not modify or delete files on the FlySight. Go-Back-N receive sequencing, eight-packet duplicate acknowledgement tracking, timer cleanup, and a 15-second keep-alive are implemented, but retransmission behavior, MTU edge cases, interrupted transfers, and physical-device compatibility still require testing. The iOS Swift source is type-checked in GitHub Actions. See [the integration plan](docs/flysight-2-integration.md).

## Quality checks

GitHub Actions runs `npm test`, type-checks the native iOS Swift sources, and builds the generated iOS Simulator app on pushes to `main` and pull requests.

## Deployment

The project includes a Vercel catch-all API function and `vercel.json`. Connect this repository to the existing Vercel project only after reviewing the build and environment configuration. Do not create a replacement database or Vercel project.

## Safety and privacy

Jump records are private user data. All data routes must enforce authenticated ownership. Voice extraction creates a reviewable draft and must never save a jump without explicit user confirmation. Track-derived opening metrics are estimates and must be reviewed by the user; they are not safety-critical measurements.
