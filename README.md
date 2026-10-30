# BASE Jump Logbook

Private, mobile-first BASE jumping logbook.

## Status

This repository contains the secure API foundation and current web prototype. It is **not yet production-ready**: frontend authentication and cloud persistence still need end-to-end integration, and media storage is not yet connected.

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

## Deployment

The project includes a Vercel catch-all API function and vercel.json. Connect this repository to the existing Vercel project only after reviewing the build and environment configuration. Do not create a replacement database or Vercel project.

## Safety and privacy

Jump records are private user data. All data routes must enforce authenticated ownership. Voice extraction creates a reviewable draft and must never save a jump without explicit user confirmation.
