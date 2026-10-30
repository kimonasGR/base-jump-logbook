import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));

test('all private data routes require authenticated user middleware', () => {
  for (const route of [
    "app.get('/api/me', requireUser",
    "app.get('/api/objects', requireUser",
    "app.post('/api/objects', requireUser",
    "app.patch('/api/objects/:id', requireUser",
    "app.delete('/api/objects/:id', requireUser",
    "app.get('/api/gear', requireUser",
    "app.post('/api/gear', requireUser",
    "app.patch('/api/gear/:id', requireUser",
    "app.delete('/api/gear/:id', requireUser",
    "app.get('/api/jumps', requireUser",
    "app.post('/api/jumps', requireUser",
    "app.patch('/api/jumps/:id', requireUser",
    "app.delete('/api/jumps/:id', requireUser",
    "app.get('/api/custom-options', requireUser",
    "app.post('/api/custom-options', requireUser",
    "app.delete('/api/custom-options/:id', requireUser",
    "app.post('/api/voice/extract', requireUser"
  ]) assert.ok(server.includes(route), `Missing protected route: ${route}`);
});

test('snapshot cloud sync is authenticated and user-scoped', () => {
  assert.ok(server.includes("app.get('/api/snapshot', requireUser"));
  assert.ok(server.includes("app.put('/api/snapshot', requireUser"));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_snapshots/);
});

test('database enforces per-user ownership and unique jump numbering', () => {
  assert.match(migration, /UNIQUE\s*\(user_id,\s*jump_number\)/i);
  assert.match(migration, /REFERENCES app_users\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /CHECK\s*\(\(object_type IS DISTINCT FROM 'Other'\)/i);
});

test('voice extraction returns a draft and never writes a jump', () => {
  const start = server.indexOf("app.post('/api/voice/extract'");
  const end = server.indexOf("app.use((err", start);
  const handler = server.slice(start, end);
  assert.match(handler, /requiresConfirmation:true/);
  assert.match(handler, /storedAudio:false/);
  assert.doesNotMatch(handler, /INSERT INTO jumps/i);
});

test('Vercel catch-all API function and rewrite are configured', () => {
  assert.ok(vercel.builds.some(b => b.src === 'public/**' && b.use === '@vercel/static'));
  assert.ok(vercel.builds.some(b => b.src === 'api/[...path].js' && b.use === '@vercel/node'));
  assert.ok(vercel.routes.some(r => r.src === '/api/(.*)' && r.dest === '/api/[...path].js'));
  assert.ok(vercel.routes.some(r => r.src === '/' && r.dest === '/public/index.html'));
});

test('dangerous values are not committed in the example environment file', async () => {
  const env = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /DATABASE_URL=postgresql:\/\/USER:PASSWORD/);
  assert.match(env, /OPENAI_API_KEY=$/m);
  assert.doesNotMatch(env, /sk-[A-Za-z0-9]{20,}/);
});

test('API server module loads without schema construction errors', async () => { process.env.VERCEL = '1'; const server = await import('../src/server.js'); assert.equal(typeof server.default, 'function'); });
