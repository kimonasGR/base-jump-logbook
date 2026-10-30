# BASE Jump Logbook — secure backend + voice extraction

This package extends the visual prototype with a server-side API foundation for persistent per-user records and AI voice-to-field extraction.

## Resources created

A dedicated Neon PostgreSQL project named `base-jump-logbook` was created in AWS Frankfurt (`aws-eu-central-1`). Neon Auth is provisioned on its `main` branch. The database contains the initial `app_users`, `objects`, `gear_presets`, `jumps`, `jump_media`, and `custom_options` tables plus indexes. This database is separate from other projects.

Neon Auth endpoints:

- Auth base URL: `https://ep-young-truth-badvxgct.neonauth.c-8.eu-central-1.aws.neon.tech/neondb/auth`
- JWKS URL: `https://ep-young-truth-badvxgct.neonauth.c-8.eu-central-1.aws.neon.tech/neondb/auth/.well-known/jwks.json`

## API capabilities

- JWT verification against Neon Auth JWKS; every data endpoint requires a valid Bearer token.
- Every jump, object and gear query is scoped to the authenticated user ID.
- `GET/POST /api/jumps`, `PATCH/DELETE /api/jumps/:id`
- `GET/POST /api/objects`
- `GET/POST /api/gear`
- `POST /api/voice/extract` accepts one audio file, transcribes it, then extracts a strict JSON draft for all agreed jump fields.
- Voice extraction returns `requiresConfirmation: true`; it does not save the jump or retain the audio.
- Object type `Other` requires a description at API validation and database constraint levels.
- Audio uploads are limited to 20 MB; request validation and security headers are enabled.

## Important remaining integration work

This is not yet a public deployed application. The original `index.html` is included as the UI prototype; it is not yet wired to the API or a complete sign-in screen. Before production use, connect a browser auth flow to Neon Auth, send access tokens with API requests, replace localStorage persistence with the API, add object-storage upload/download routes for media, implement map selection, and deploy the app with environment variables. The OpenAI API key is intentionally not included and must be provided by the owner.

## Run the API locally

Requires Node.js 20+.

```bash
cp .env.example .env
# Fill in DATABASE_URL and OPENAI_API_KEY; keep .env private.
npm install
npm start
```

Use the Neon connection string from the Neon Console as `DATABASE_URL`. Never put the database URL or OpenAI key in frontend code or commit them to Git. Configure the Neon Auth issuer/JWKS values shown above. If your issued token's `iss` claim differs from the configured issuer, use the exact issuer from a token created by the auth integration.

Health check: `GET http://localhost:8787/api/health`

## Voice endpoint usage

Send a `multipart/form-data` request to `/api/voice/extract` with `audio=<recording>` and `Authorization: Bearer <Neon Auth access token>`. The endpoint returns the transcription and a structured draft. The UI must show the draft for review and only then call `POST /api/jumps`.

## Production safety checklist

- Set `NODE_ENV=production`, a strict `CORS_ORIGIN`, and TLS database connection.
- Keep secrets only in server environment variables.
- Use private object storage with short-lived signed URLs for media; do not store large files in PostgreSQL.
- Add rate limiting and request monitoring before public release.
- Test JWT issuer/audience claims against real Neon Auth sessions.
- Test migrations, ownership isolation, export and deletion flows.
- Do not rely on this package alone as a certified safety-critical record system; maintain independent backups.


## Repository and deployment layout

- `index.html` is the current browser prototype and still uses browser-local storage.
- `src/server.js` is the Express API; `api/[...path].js` adapts it to Vercel Functions.
- `vercel.json` routes `/api/*` to the function.
- `npm test` runs static contract checks.

## Current implementation boundary (read before production)

The API now includes authenticated CRUD routes for jumps, objects and gear presets, plus custom-option CRUD. Ownership is enforced in SQL predicates and user-scoped foreign keys. Voice extraction produces a reviewable draft only. The browser UI is **not yet integrated** with Neon Auth or these APIs: its current record persistence and media attachments remain local to the browser. No cloud media storage provider has been configured. Do not treat this build as a cloud-synced production release until the browser authentication/token flow, API data adapter, media storage and end-to-end tests are completed.

For Vercel, configure `DATABASE_URL`, `NEON_AUTH_JWKS_URL`, `NEON_AUTH_ISSUER`, `OPENAI_API_KEY`, `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_EXTRACT_MODEL`, and `CORS_ORIGIN` as project environment variables. Never commit `.env`. Apply `migrations/001_initial.sql` to the dedicated Neon project before first use.
