import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
const flySightMigration = await readFile(new URL('../migrations/002_flysight_handoff.sql', import.meta.url), 'utf8');
const mediaMigration = await readFile(new URL('../migrations/003_user_media.sql', import.meta.url), 'utf8');
const nativeFlySight = await readFile(new URL('../native/ios/FlySightConnectionView.swift', import.meta.url), 'utf8');
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
  assert.match(ui, /remote=j\.media\|\|\[\]/);
  assert.match(ui, /local\.filter\(m=>!m\.storageId\)/);
  assert.match(ui, /local\.find\(l=>l\.storageId===m\.storageId\)/);
});

test('settings accurately disclose cloud media configuration and current voice limitations', () => {
  assert.match(ui, /Photos and videos upload to private Neon Object Storage when configured; otherwise they remain on this device/);
  assert.match(ui, /Records audio and sends it to the private AI extraction endpoint/);
  assert.match(ui, /nothing is saved until you review and submit the jump/);
});

test('jump media uses private Neon Object Storage with user-scoped metadata', () => {
  assert.ok(server.includes("app.post('/api/media', requireUser, mediaUpload.single('file')"));
  assert.ok(server.includes("app.get('/api/media/:id/url', requireUser"));
  assert.ok(server.includes("app.delete('/api/media/:id', requireUser"));
  assert.match(server, /MEDIA_SCHEMA_NOT_READY/);
  assert.match(server, /new S3Client\(\{[\s\S]*forcePathStyle: true/);
  assert.match(server, /getSignedUrl\(s3,[\s\S]*expiresIn:900/);
  assert.match(server, /WHERE id=\$1 AND user_id=\$2/);
  assert.match(mediaMigration, /CREATE TABLE IF NOT EXISTS user_media/);
  assert.match(mediaMigration, /REFERENCES app_users\(id\) ON DELETE CASCADE/);
  assert.match(mediaMigration, /size_bytes BIGINT NOT NULL CHECK/);
});

test('jump media uploads preserve local copies and sync only private media metadata', () => {
  assert.match(ui, /window\.uploadCloudMedia=async\(jumpId,items\)/);
  assert.match(ui, /items\.filter\(item=>item\.storageId&&!item\.data\)/);
  assert.match(ui, /window\.loadCloudMedia=async\(items\)/);
  assert.match(ui, /window\.deleteCloudMedia=async\(id\)/);
  assert.match(ui, /Promise\.allSettled\(uploaded\.map\(item=>window\.deleteCloudMedia\(item\.storageId\)\)\)/);
  assert.match(ui, /could not be rolled back/);
  assert.match(ui, /storageId:m\.storageId,name:m\.name,type:m\.type,sizeBytes:m\.sizeBytes/);
  assert.match(ui, /media:\(j\.media\|\|\[\]\)\.map\(\(\{url,\.\.\.m\}\)=>m\)/);
  assert.match(ui, /Photos and videos upload to private Neon storage when configured/);
  assert.match(ui, /mediaDraft\.filter\(m=>m\.data&&!m\.storageId\)/);
  assert.match(ui, /let pendingMediaDeletes=\[\]/);
  assert.match(ui, /pendingMediaDeletes\.forEach\(id=>window\.deleteCloudMedia/);
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
  assert.match(handler, /INSERT INTO user_snapshots\(user_id,payload,updated_at\) SELECT \$1/);
  assert.match(handler, /\$3::timestamptz IS NULL AND NOT EXISTS \(SELECT 1 FROM user_snapshots WHERE user_id=\$1\)/);
  assert.match(handler, /\$3::timestamptz IS NOT NULL AND EXISTS \(SELECT 1 FROM user_snapshots WHERE user_id=\$1\)/);
  assert.match(handler, /WHERE user_snapshots\.updated_at=\$3::timestamptz/);
  assert.match(handler, /GREATEST\(date_trunc\('milliseconds',clock_timestamp\(\)\),user_snapshots\.updated_at \+ interval '1 millisecond'\)/);
  assert.match(handler, /res\.status\(409\)/);
  assert.match(handler, /SNAPSHOT_CONFLICT/);
});

test('frontend pauses cloud sync on conflict, resets stale conflict state and exposes two-way recovery', () => {
  assert.match(ui, /cloudUpdatedAt=null/);
  assert.match(ui, /expectedUpdatedAt:cloudUpdatedAt/);
  assert.match(ui, /cloudUpdatedAt=result\.updatedAt/);
  assert.match(ui, /cloudReady=false;syncAgain=false/);
  assert.match(ui, /cloudReady=false;cloudConflict=true;syncAgain=false/);
  assert.match(ui, /cloudReady=false;cloudConflict=false;syncAgain=false/);
  assert.match(ui, /cloudConflict=false;cloudReady=true;gate\.style\.display='none'/);
  assert.match(ui, /id="conflictLoadCloud"/);
  assert.match(ui, /id="conflictKeepLocal"/);
  assert.match(ui, /expectedUpdatedAt:latest\.updatedAt\|\|null/);
  assert.match(ui, /const backupTime=window\.createLocalRecoveryBackup\(\)/);
});

test('HTML contains one application shell and one Neon Auth bootstrap', () => {
  assert.equal((ui.match(/id="authGate"/g) || []).length, 1);
  assert.equal((ui.match(/const AUTH_URL=/g) || []).length, 1);
  assert.equal((ui.match(/<script/g) || []).length, 2);
  assert.equal((ui.match(/<\/script>/g) || []).length, 2);
  assert.ok(ui.trimEnd().endsWith('</body></html>'));
});

test('cloud sync retries transient failures and waits for reconnection while offline', () => {
  assert.match(ui, /function scheduleCloudRetry\(\)/);
  assert.match(ui, /Math\.min\(60000,1000\*\(2\*\*Math\.min\(syncRetryAttempt,6\)\)\)/);
  assert.match(ui, /navigator\.onLine===false/);
  assert.match(ui, /addEventListener\('online'/);
  assert.match(ui, /error\.status=response\.status;error\.code=data\.code/);
  assert.match(ui, /e\.status===408\|\|e\.status===429\|\|e\.status>=500/);
});

test('erase-all warns about cloud propagation and requires a recovery backup', () => {
  assert.match(ui, /If cloud sync is active, this empty logbook will also replace the cloud copy/);
  assert.match(ui, /const backupTime=window\.createLocalRecoveryBackup\(\);localStorage\.removeItem\(KEY\);db=structuredClone\(defaults\);persist\(\)/);
  assert.match(ui, /Erase cancelled: a recovery backup could not be created, so no data was removed/);
});

test('JSON backup import creates a recovery copy before replacing local records', () => {
  assert.match(ui, /Replace current local data with this backup\? A recovery copy of the current device data will be created first\./);
  assert.match(ui, /backupTime=window\.createLocalRecoveryBackup\(\);db=\{\.\.\.structuredClone\(defaults\),\.\.\.x\};persist\(\);render\(\)/);
  assert.match(ui, /Import cancelled: a safety backup could not be created, so current data was not replaced/);
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
  assert.match(ui, /\.slice\(0,10000\)/);
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
  assert.match(ui, /downKey=find\(\['veld','vel_d','velocity down','down velocity'\]\)/);
  assert.match(ui, /p\.velD=number\(row\[downKey\]\)/);
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
  assert.match(ui, /a\[0\]!==/);
  assert.match(ui, /\['GNSS','GPS','TRACK'\]/);
  assert.match(ui, /function splitCsvLine\(line\)/);
});

test('FlySight import reverse-geocodes GPS coordinates into country field', () => {
  assert.match(ui, /window\.lookupCountry=async\(latitude,longitude\)=>/);
  assert.match(ui, /const place=await window\.lookupCountry\?\.\(points\[0\]\.lat,points\[0\]\.lon\)/);
  assert.match(ui, /Authorization:'Bearer '\+bearer/);
  assert.match(ui, /if\(place&&!form\.elements\.country\.value\.trim\(\)\)\{form\.elements\.country\.value=place/);
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

test('FlySight import reverse-geocodes GPS coordinates into country field', () => {
  assert.match(ui, /window\.lookupCountry=async\(latitude,longitude\)=>/);
  assert.match(ui, /const place=await window\.lookupCountry\?\.\(points\[0\]\.lat,points\[0\]\.lon\)/);
  assert.match(ui, /Authorization:'Bearer '\+bearer/);
  assert.match(ui, /if\(place&&!form\.elements\.country\.value\.trim\(\)\)\{form\.elements\.country\.value=place/);
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


test('native FlySight upload retries transient HTTP and transport failures', () => {
  assert.match(nativeFlySight, /private func sendUploadRequest\(_ request: URLRequest\) async throws/);
  assert.match(nativeFlySight, /for attempt in 0\.\.\<3/);
  assert.match(nativeFlySight, /http\.statusCode == 408 \|\| http\.statusCode == 429 \|\| http\.statusCode >= 500/);
  assert.match(nativeFlySight, /Task\.sleep\(nanoseconds:/);
  assert.match(nativeFlySight, /catch is CancellationError/);
  assert.match(nativeFlySight, /try await Task\.sleep/);
});

test('FlySight inbox offers explicit deletion after files are imported into the draft', () => {
  assert.match(ui, /id="clearFlySightInbox"/);
  assert.match(ui, /const inboxStatus=document.getElementById\('flySightInboxStatus'\)/);
  assert.match(ui, /inboxStatus\.textContent='Uploaded files deleted/);
  assert.match(ui, /method:'DELETE'/);
  assert.match(ui, /Uploaded files deleted from the secure inbox/);
});

test('FlySight imports retain source-file provenance and SHA-256 fingerprints', () => {
  assert.match(ui, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(ui, /sourceFiles/);
  assert.match(ui, /sha256/);
  assert.match(ui, /Source files:/);
  assert.match(ui, /existingIndex=sourceFiles\.findIndex\(x=>x\.kind===incoming\.kind\)/);
});


const nativeBLE = await readFile(new URL('../native/ios/FlySightBLEClient.swift', import.meta.url), 'utf8');

test('FlySight downloads enforce import-size and transfer-integrity limits', () => {
  assert.ok(nativeBLE.includes('maximumImportFileSize = 15 * 1024 * 1024'));
  assert.ok(nativeBLE.includes('guard !transferIsActive'));
  assert.ok(nativeBLE.includes('expectedSize <= UInt32(maximumImportFileSize)'));
  assert.ok(nativeBLE.includes('nextSize <= maximumImportFileSize'));
  assert.ok(nativeBLE.includes('FileTransferError.sizeMismatch'));
  assert.ok(nativeBLE.includes('FileTransferError.transferInProgress'));
});


test('FlySight handoff uses short-lived hashed upload tokens and bounded chunk storage', () => {
  assert.match(server, /randomBytes\(32\)/);
  assert.match(server, /tokenDigest\(token\)/);
  assert.match(server, /expires_at>now\(\)/);
  assert.match(server, /handoffChunkBytes = 256 \* 1024/);
  assert.match(server, /handoffFileLimit = 15 \* 1024 \* 1024/);
  assert.match(server, /app\.post\('\/api\/flysight\/handoffs\/upload'/);
  assert.match(server, /app\.get\('\/api\/flysight\/handoffs', requireUser/);
  assert.match(server, /h\.user_id=\$3/);
  assert.match(flySightMigration, /CREATE TABLE IF NOT EXISTS flysight_handoffs/);
  assert.match(flySightMigration, /CREATE TABLE IF NOT EXISTS flysight_handoff_chunks/);
  assert.match(flySightMigration, /ON DELETE CASCADE/);
});


test('FlySight handoff uploads lock and revalidate the token row before enforcing the two-file limit', () => {
  assert.match(server, /lockedSession=await client\.query\([\s\S]*FOR UPDATE/);
  assert.match(server, /if\(!lockedSession\.rowCount\)[\s\S]*Handoff token is invalid or expired/);
});

test('native FlySight uploader uses HTTPS, bounded chunks and the scoped handoff token', () => {
  assert.match(nativeFlySight, /scheme == "https"/);
  assert.match(nativeFlySight, /256 \* 1024/);
  assert.match(nativeFlySight, /15 \* 1024 \* 1024/);
  assert.match(nativeFlySight, /X-FlySight-Handoff/);
  assert.match(nativeFlySight, /SHA256\.hash\(data: data\)/);
  assert.match(nativeFlySight, /TRACK\.CSV.*SENSOR\.CSV.*TRACK\.GPX/);
});

test('web logbook can create a handoff token and load verified uploaded chunks into the existing importer', () => {
  assert.match(ui, /createFlySightHandoff/);
  assert.match(ui, /\/api\/flysight\/handoffs/);
  assert.match(ui, /loadFlySightInbox/);
  assert.match(ui, /crypto\.subtle\.digest\('SHA-256',bytes\)/);
  assert.match(ui, /picker\.dispatchEvent\(new Event\('change'/);
});


test('primary navigation exists only in the fixed bottom bar', () => {
  assert.match(ui, /<nav class="bottom">/);
  assert.doesNotMatch(ui, /<div class="tabs" id="tabs">/);
  assert.doesNotMatch(ui, /<button class="iconbtn" id="settingsTop"/);
  assert.match(ui, /data-view="logbook"/);
  assert.match(ui, /data-view="objects"/);
  assert.match(ui, /data-view="gear"/);
  assert.match(ui, /data-view="settings"/);
});

test('jump media helper text describes private cloud upload rather than local-only prototype storage', () => {
  assert.match(ui, /Photos and videos are uploaded to your private cloud storage when configured/);
  assert.doesNotMatch(ui, /For this prototype, media is stored locally/);
});


test('AI logbook import is selectable before account creation and from Settings', () => {
  assert.match(ui, /id="firstLoginLogbook"/);
  assert.match(ui, /id="aiLogbookImport"/);
  assert.match(ui, /pendingLogbookFile/);
  assert.match(ui, /await startAiLogbookImport\(firstFile,status\)/);
});

test('AI logbook import is authenticated, draft-only, reviewed and merged without replacing existing jumps', () => {
  assert.match(server, /app\.post\('\/api\/logbook\/import-analyze', requireUser/);
  assert.match(server, /Buffer\.byteLength\(content,'utf8'\)>600000/);
  assert.match(server, /requiresConfirmation:true,storedFile:false/);
  assert.match(server, /draft\.jumps\.length>10000/);
  assert.match(server, /Split the source file into smaller files/);
  assert.match(server, /Array\.isArray\(draft\.mappingSummary\)/);
  assert.match(ui, /showAiImportPreview/);
  assert.match(ui, /Add jumps to my logbook/);
  assert.match(ui, /db\.jumps=\[\.\.\.db\.jumps,\.\.\.newJumps\]/);
  assert.match(ui, /window\.createLocalRecoveryBackup\(\)/);
  assert.match(ui, /Supported formats: CSV, TSV, TXT, JSON, XLSX and text-based PDF/);
});


test('XLSX ZIP archive is preflighted before decompression', () => {
  const start=server.indexOf('function validateXlsxZip(bytes)');
  const end=server.indexOf("app.post('/api/logbook/import-analyze'",start);
  const helper=server.slice(start,end);
  assert.ok(start>=0&&end>start);
  for(const fragment of ['0x06054b50','0x02014b50','entries>1000','flags&1','expanded/compressed>200','expanded>16*1024*1024','totalExpanded>32*1024*1024']) {
    assert.ok(helper.includes(fragment),'Missing ZIP archive guard: '+fragment);
  }
  assert.ok(server.includes('validateXlsxZip(bytes);'));
});

test('AI import preview validates row limits, dates, numeric and boolean fields before merging', () => {
  assert.match(ui, /edited\.jumps\.length>10000/);
  assert.match(ui, /invalid date/);
  assert.match(ui, /non-numeric/);
  assert.match(ui, /invalid .* value/);
  assert.match(ui, /A maximum of 10,000 jumps/);
});


test('AI logbook import uses bounded ExcelJS parsing and extracts searchable PDFs server-side', () => {
  assert.ok(server.includes("import ExcelJS from 'exceljs'"));
  assert.doesNotMatch(server, /from 'xlsx'/);
  assert.ok(server.includes("import pdfParse from 'pdf-parse'"));
  for (const fragment of [
    'new ExcelJS.Workbook()',
    'await workbook.xlsx.load(bytes)',
    'workbook.worksheets.length>30',
    'sheet.rowCount>20000||sheet.columnCount>200',
    'totalCells>200000',
    'await pdfParse(bytes)',
    'if(!content.trim())scannedPdfBase64=binary',
    "type:'input_file',filename:fileName,file_data:`data:application/pdf;base64,",
    "express.json({ limit: '12mb' })"
  ]) assert.ok(server.includes(fragment), 'Missing parser contract: '+fragment);
  assert.ok(ui.includes('.xlsx,.pdf'));
  assert.ok(ui.includes('file.arrayBuffer()'));
  assert.match(ui, /fileBase64/);
  assert.ok(ui.includes('8*1024*1024'));
});

test('jump form validates unique positive numbering, numeric values, date, time and GPS coordinates', () => {
  assert.match(ui, /Number\.isInteger\(jumpNumber\).*jump number must be a positive whole number/i);
  assert.match(ui, /db\.jumps\.some\(x=>x\.id!==j\.id&&Number\(x\.number\)===jumpNumber\)/);
  assert.match(ui, /Height',d\.height/);
  assert.match(ui, /Delay for SU',d\.delaySu/);
  assert.match(ui, /validateCoordinates\(d\.latitude,d\.longitude\)/);
  assert.match(ui, /valid time in 24-hour format/);
});

test('logbook supports duplicating a jump without copying media or FlySight attachments', () => {
  assert.match(ui, /data-duplicate-jump=/);
  assert.match(ui, /data-duplicate-jump.*number:Math\.max/);
  assert.match(ui, /media:\[\],flysightTrack:null,trackName:''/);
  assert.match(ui, /privateNotes:''/);
});

test('object database provides map links, editable records, jump history and jump counts', () => {
  assert.match(ui, /function objectHistory\(o\)/);
  assert.match(ui, /data-edit-object=/);
  assert.match(ui, /data-object-history=/);
  assert.match(ui, /data-use-object=/);
  assert.match(ui, /https:\/\/www\.google\.com\/maps\/search/);
  assert.match(ui, /Last jump:/);
  assert.match(ui, /Jump history/);
});

test('object form rejects invalid height and duplicate object names within a country', () => {
  assert.match(ui, /Object height must be a positive number/);
  assert.match(ui, /An object with this name and country already exists/);
});


test('weather conditions use structured sky, lighting, wind strength and compass wind direction fields', () => {
  assert.match(ui, /04 · Conditions[\s\S]*selectField\('Sky cover','skyCover'/);
  assert.match(ui, /selectField\('Lighting','lighting'/);
  assert.match(ui, /selectField\('Wind strength','windStrength',j\.windStrength,'Wind strength'\)/);
  assert.match(ui, /selectField\('Wind direction','windDirection',j\.windDirection,'windDirection'\)/);
  assert.match(ui, /windDirection:\['N','NE','E','SE','S','SW','W','NW','Variable'\]/);
  assert.doesNotMatch(ui, /03 · Flight & deployment[\s\S]{0,250}field\('Wind strength'/);
});


test('PWA manifest declares a standalone mobile app with a valid icon', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'BASE Jump Logbook');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some(icon => icon.src === '/icons/base-logbook.svg'));
});

test('service worker caches only the app shell and never intercepts API requests', async () => {
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /base-logbook-shell-v1/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /caches\.match\('\/'\)/);
});

test('mobile app metadata and secure service worker registration are present', () => {
  assert.match(ui, /apple-mobile-web-app-capable/);
  assert.match(ui, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(ui, /navigator\.serviceWorker\.register\('\/sw\.js'/);
  assert.match(ui, /location\.protocol === 'https:'/);
});


test('jump logbook exposes a working suit filter alongside country and object type', () => {
  assert.match(ui, /id="suitFilter"/);
  assert.match(ui, /filterSuit===c\?'selected':''/);
  assert.match(ui, /suit\.onchange=\(\)=>\{filterSuit=suit\.value;render\(\)\}/);
  assert.match(ui, /&&\(!filterSuit\|\|j\.suit===filterSuit\)/);
  assert.match(ui, /query=filterCountry=filterType=filterSuit=''/);
});


test('analytics FlySight count reads the saved track summary point count', () => {
  assert.match(ui, /Number\\(j\\.flysightTrack\\?\\.stats\\?\\.points\\)>0/);
  assert.match(ui, /Array\\.isArray\\(j\\.flysightTrack\\?\\.trackPoints\\)/);
});

test('analytics view summarizes historical jumps by year, object, jump type, suit and rig', () => {
  assert.match(ui, /data-view="analytics"/);
  assert.match(ui, /function renderAnalytics\(\)/);
  assert.match(ui, /Jumps by year/);
  assert.match(ui, /Most visited objects/);
  assert.match(ui, /Jump types/);
  assert.match(ui, /Data completeness/);
  assert.match(ui, /descriptive summaries of saved records, not predictions or safety assessments/);
});
