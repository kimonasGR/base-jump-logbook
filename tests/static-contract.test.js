import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
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

test('objects are created through jump saves, never manually', () => {
  assert.doesNotMatch(ui, /id="newObject"/);
  assert.match(ui, /const objectRecord=\{id:objectId,name:d\.objectName\.trim\(\)/);
  assert.match(ui, /Objects are added automatically when you save a jump/);
});

test('cloud conflict cancellation never uploads local data over the cloud copy', () => {
  assert.match(ui, /backupTime=window\.createLocalRecoveryBackup\(\)/);
  assert.match(ui, /if\(!confirm\('A cloud logbook already exists/);
  assert.match(ui, /Your local records remain unchanged/);
  assert.doesNotMatch(ui, /gate\.style\.display='none';cloudReady=true;await syncCloud\(\);return/);
});

test('cloud restore retains local-only media for matching jump IDs', () => {
  assert.match(ui, /const localMedia=new Map\(db\.jumps\.map\(j=>\[j\.id,j\.media\|\|\[\]\]\)\)/);
  assert.match(ui, /media:j\.media\|\|localMedia\.get\(j\.id\)\|\|\[\]/);
});

test('settings accurately disclose local-only media and current voice limitations', () => {
  assert.match(ui, /Photos and videos are currently stored only on this device\. FlySight GPS track data syncs/);
  assert.match(ui, /Records audio and sends it to the private AI extraction endpoint/);
  assert.match(ui, /nothing is saved until you review and submit the jump/);
});

test('AI voice draft is wired to the authenticated extraction endpoint', () => {
  assert.match(ui, /window\.extractVoiceAudio=async\(blob\)/);
  assert.match(ui, /fetch\('\/api\/voice\/extract'/);
  assert.match(ui, /form\.append\('audio',blob,'jump-audio\.webm'\)/);
  assert.match(ui, /AI draft ready/);
  assert.match(ui, /No jump was saved/);
});

test('AI voice extraction maps to actual jump form field names', () => {
  assert.match(ui, /wind_strength:'windStrength'/);
  assert.match(ui, /beautiful_people_around:'beautifulPeople'/);
  assert.match(ui, /deployment_method:'deploymentMethod'/);
  assert.match(ui, /opening_direction_degrees:'openingDirection'/);
  assert.match(ui, /id="voiceJumpForm"/);
});

test('AI draft converts boolean and opening-direction fields to UI option values', () => {
  assert.match(ui, /key==='off_heading'\|\|key==='correction'/);
  assert.match(ui, /value\?'Yes':'No'/);
  assert.match(ui, /opening_direction_degrees==='number'/);
  assert.match(ui, /new Option\(String\(display\),String\(display\)\)/);
});

test('snapshot writes use optimistic concurrency and reject stale device copies', () => {
  const start = server.indexOf("app.put('/api/snapshot'");
  const end = server.indexOf("\n\napp.use((err", start);
  const handler = server.slice(start, end);
  assert.match(handler, /expectedUpdatedAt/);
  assert.match(handler, /WHERE user_snapshots\.updated_at=\$3::timestamptz/);
  assert.match(handler, /res\.status\(409\)/);
  assert.match(handler, /SNAPSHOT_CONFLICT/);
});

test('frontend pauses cloud sync on conflict and tracks the acknowledged cloud version', () => {
  assert.match(ui, /cloudUpdatedAt=null/);
  assert.match(ui, /expectedUpdatedAt:cloudUpdatedAt/);
  assert.match(ui, /cloudUpdatedAt=result\.updatedAt/);
  assert.match(ui, /cloudReady=false;syncAgain=false;status\.textContent='Sync paused/);
});

test('local data is backed up before a cloud restore can replace it', () => {
  assert.match(ui, /window\.createLocalRecoveryBackup=\(\)=>/);
  assert.match(ui, /baseLogbookRecoveryBackups\.v1/);
  assert.match(ui, /backupTime=window\.createLocalRecoveryBackup\(\)/);
  assert.match(ui, /if\(!confirm\('A cloud logbook already exists/);
  assert.match(ui, /id="exportRecovery"/);
});

test('FlySight importer parses GPX and CSV into bounded GPS track points', () => {
  assert.match(ui, /function parseFlySightCsv\(raw\)/);
  assert.match(ui, /function parseFlySightGpx\(raw\)/);
  assert.match(ui, /function summarizeTrack\(points\)/);
  assert.match(ui, /points\.length>=10000/);
  assert.match(ui, /f\.size>15\*1024\*1024/);
  assert.match(ui, /flysightTrack:trackDraft/);
  assert.match(ui, /Track points and flight statistics are saved with this jump/);
});

test('FlySight route preview is rendered from bounded GPS coordinates', () => {
  assert.match(ui, /function trackPreviewHtml\(t\)/);
  assert.match(ui, /aria-label="Imported FlySight GPS track"/);
  assert.match(ui, /trackPreviewHtml\(trackDraft\)/);
});

test('FlySight import estimates deployment delay and altitude loss for review', () => {
  assert.match(ui, /velD=find\(\['veld','down velocity','vertical velocity'\]\)/);
  assert.match(ui, /function detectDeployment\(points\)/);
  assert.match(ui, /startIndex=rows\.findIndex/);
  assert.match(ui, /delaySeconds/);
  assert.match(ui, /altitudeLossMeters/);
  assert.match(ui, /openingAltitudeLoss/);
  assert.match(ui, /verify the estimated opening values/);
  assert.match(ui, /confidence/);
});

test('FlySight time parser supports elapsed seconds and absolute timestamps', () => {
  assert.match(ui, /function trackTimeMs\(value\)/);
  assert.match(ui, /const ts=trackTimeMs\(p\.time\)/);
  assert.match(ui, /times=points\.map\(p=>trackTimeMs\(p\.time\)\)/);
});

test('FlySight altitude profile uses imported altitude samples', () => {
  assert.match(ui, /function trackProfileHtml\(t\)/);
  assert.match(ui, /aria-label=\"FlySight altitude profile\"/);
  assert.match(ui, /trackProfileHtml\(trackDraft\)/);
});

test('FlySight import auto-fills opening metrics before remaining jump details', () => {
  assert.match(ui, /field\('Altitude at opening \(m\)','openingAltitude'/);
  assert.match(ui, /form\.elements\.delay\.value=trackDraft\.deployment\.delaySeconds/);
  assert.match(ui, /form\.elements\.openingAltitude\.value=trackDraft\.deployment\.openingAltitudeMeters/);
  assert.match(ui, /form\.elements\.openingAltitudeLoss\.value=trackDraft\.deployment\.altitudeLossMeters/);
  assert.match(ui, /Complete the remaining jump details and verify the estimated opening values/);
});
test('FlySight 2 native multi-line TRACK.CSV headers and sensor rows are supported', () => {
  assert.match(ui, /startsWith\('\$FLYS'\)/);
  assert.match(ui, /findIndex\(x=>x\.trim\(\)==='\$DATA'\)/);
  assert.match(ui, /a\[0\]!==\('\
  assert.match(ui, /\['GNSS','GPS','TRACK'\]/);
  assert.match(ui, /function splitCsvLine\(line\)/);
});

test('FlySight import reverse-geocodes GPS coordinates into country field', () => {
  assert.match(ui, /api\/geocode\/reverse\?lat=/);
  assert.match(ui, /Authorization:'Bearer '\+bearer/);
  assert.match(ui, /if\(place\.country&&!form\.elements\.country\.value\.trim\(\)\)\{form\.elements\.country\.value=place\.country/);
});
test('FlySight 2 vertical velocity sign is normalized for descent detection', () => {
  assert.match(ui, /Number\.isFinite\(p\.velD\)\?-p\.velD/);
});
test('Reverse geocoding is authenticated and validates coordinates', () => {
  assert.match(server, /app\.get\('\/api\/geocode\/reverse', requireUser/);
  assert.match(server, /Math\.abs\(latitude\)>90/);
  assert.match(server, /address\?\.country/);
});

test('FlySight 2 SENSOR.CSV imports sensor schemas, units, variables and samples', () => {
  assert.match(ui, /function parseFlySightSensorCsv\(raw\)/);
  assert.match(ui, /a\[0\]==='\$COL'/);
  assert.match(ui, /a\[0\]==='\$UNIT'/);
  assert.match(ui, /a\[0\]==='\$VAR'/);
  assert.match(ui, /sensor\.samples\+\+/);
  assert.match(ui, /m\.min=Math\.min\(m\.min,n\)/);
  assert.match(ui, /m\.average=m\.count\?m\.sum\/m\.count:null/);
  assert.match(ui, /name==='SENSOR\.CSV'\|\|name\.includes\('SENSOR'\)/);
});
test('FlySight import accepts TRACK and SENSOR files together', () => {
  assert.match(ui, /id="flySight" type="file" accept="\.gpx,\.csv" multiple/);
  assert.match(ui, /trackDraft\.sensorData\?'<div class=/);
  assert.match(ui, /Sensor files imported:/);
});
\+sensor\)/);
  assert.match(ui, /\['GNSS','GPS','TRACK'\]/);
  assert.match(ui, /function splitCsvLine\(line\)/);
});

test('FlySight import reverse-geocodes GPS coordinates into country field', () => {
  assert.match(ui, /api\/geocode\/reverse\?lat=/);
  assert.match(ui, /Authorization:'Bearer '\+bearer/);
  assert.match(ui, /if\(place\.country&&!form\.elements\.country\.value\.trim\(\)\)\{form\.elements\.country\.value=place\.country/);
});
test('FlySight 2 vertical velocity sign is normalized for descent detection', () => {
  assert.match(ui, /Number\.isFinite\(p\.velD\)\?-p\.velD/);
});
test('Reverse geocoding is authenticated and validates coordinates', () => {
  assert.match(server, /app\.get\('\/api\/geocode\/reverse', requireUser/);
  assert.match(server, /Math\.abs\(latitude\)>90/);
  assert.match(server, /address\?\.country/);
});

test('FlySight 2 SENSOR.CSV imports sensor schemas, units, variables and samples', () => {
  assert.match(ui, /function parseFlySightSensorCsv\(raw\)/);
  assert.match(ui, /a\[0\]==='\$COL'/);
  assert.match(ui, /a\[0\]==='\$UNIT'/);
  assert.match(ui, /a\[0\]==='\$VAR'/);
  assert.match(ui, /sensor\.samples\+\+/);
  assert.match(ui, /m\.min=Math\.min\(m\.min,n\)/);
  assert.match(ui, /m\.average=m\.count\?m\.sum\/m\.count:null/);
  assert.match(ui, /name==='SENSOR\.CSV'\|\|name\.includes\('SENSOR'\)/);
});
test('FlySight import accepts TRACK and SENSOR files together', () => {
  assert.match(ui, /id="flySight" type="file" accept="\.gpx,\.csv" multiple/);
  assert.match(ui, /trackDraft\.sensorData\?'<div class=/);
  assert.match(ui, /Sensor files imported:/);
});
