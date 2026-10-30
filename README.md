# BASE Jump Logbook

Private, mobile-first BASE jumping logbook.

## Status

This repository contains a private web logbook prototype with authenticated API routes, account-scoped cloud snapshot sync, local recovery backups, and FlySight GPX/CSV import. It is **not yet production-ready**: native iOS Bluetooth integration, end-to-end device testing, and cloud media storage are not complete. Photos and videos remain local to the device; imported FlySight track and sensor summaries are included in the cloud-synced jump record.

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

Configure DATABASE_URL, NEON_AUTH_ISSUER, NEON_AUTH_JWKS_URL, and OPENAI_API_KEY in your local .env or deployment environment. Never commit real credentials.

## FlySight 2\n\nThe web app can import `TRACK.CSV` and `SENSOR.CSV` together. Sensor streams currently produce sample counts and basic measurement summaries. Direct iPhone-to-FlySight Bluetooth transfer is not implemented yet; see [the integration plan](docs/flysight-2-integration.md).\n\n## Quality checks\n\nGitHub Actions runs `npm test` on pushes to `main` and pull requests.\n\n## Deployment

The project includes a Vercel catch-all API function and vercel.json. Connect this repository to the existing Vercel project only after reviewing the build and environment configuration. Do not create a replacement database or Vercel project.

## Safety and privacy

Jump records are private user data. All data routes must enforce authenticated ownership. Voice extraction creates a reviewable draft and must never save a jump without explicit user confirmation.
