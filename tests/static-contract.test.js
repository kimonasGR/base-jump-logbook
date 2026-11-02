import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const ui = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
const flySightMigration = await readFile(new URL('../migrations/002_flysight_handoff.sql', import.meta.url), 'utf8');
const mediaMigration = await readFile(new URL('../migrations/003_user_media.sql', import.meta.url), 'utf8');
const nativeFlySight = await readFile(new URL('../native/ios/FlySightConnectionView.swift', import.meta.url), 'utf8');
const nativeFlySightBLE = await readFile(new URL('../native/ios/FlySightBLEClient.swift', import.meta.url), 'utf8');
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

test('initial cloud restore preserves local data unless cloud replacement is explicitly confirmed', () => {
  assert.match(ui, /backupTime=window\.createLocalRecoveryBackup\(\)/);
  assert.match(ui, /Choose OK to load the cloud copy and replace this device’s records\. Choose Cancel to keep this device’s records and upload them to the cloud/);
  assert.match(ui, /if\(loadCloud\)window\.setCloudSnapshot\(cloud\.snapshot\);\s*else\{/);
  assert.match(ui, /expectedUpdatedAt:cloud\.updatedAt\|\|null/);
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

test('inline application script parses as valid JavaScript', () => {
  const start=ui.lastIndexOf('<script>');
  const end=ui.indexOf('</script>',start);
  assert.ok(start>=0&&end>start,'Expected inline application script');
  assert.doesNotThrow(()=>new Function(ui.slice(start+8,end)));
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
  assert.match(ui, /Choose OK to load the cloud copy and replace this device’s records/);
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

test('FlySight 2 SENSOR.CSV parser handles BOM, CRLF, sensor prefixes and empty values', () => {
  const splitStart=ui.indexOf('function splitCsvLine(');
  const trackStart=ui.indexOf('function parseFlySightCsv(');
  const sensorStart=ui.indexOf('function parseFlySightSensorCsv(');
  const gpxStart=ui.indexOf('function parseFlySightGpx(');
  const splitSource=ui.slice(splitStart,trackStart);
  const metaStart=ui.indexOf('function parseFlySightMetadata(');
  const sensorSource=ui.slice(metaStart,sensorStart)+ui.slice(sensorStart,gpxStart);
  const parseSensor=new Function(splitSource+sensorSource+';return parseFlySightSensorCsv;')();
  const raw='\uFEFF$FLYS,2\r\n$VAR,IMU,Inertial measurement unit\r\n$COL,IMU,TIME,ACC_X,ACC_Y,ACC_Z\r\n$UNIT,IMU,ms,m/s2,m/s2,m/s2\r\n$DATA\r\n$IMU,100,1,,3\r\n$IMU,200,5,7,9\r\n';
  const parsed=parseSensor(raw);
  assert.equal(parsed.totalSamples,2);
  assert.equal(parsed.variables.IMU,'Inertial measurement unit');
  assert.deepEqual(parsed.sensors.IMU.units,['ms','m/s2','m/s2','m/s2']);
  assert.equal(parsed.sensors.IMU.measurements.acc_x.average,3);
  assert.equal(parsed.sensors.IMU.sampleRateHz,10);
  assert.equal(parsed.sensors.IMU.durationSeconds,0.1);
  assert.equal(parsed.sensors.IMU.measurements.time,undefined);
  assert.equal(parsed.sensors.IMU.measurements.acc_y.average,7);
  assert.equal(parsed.sensors.IMU.missingValues,1);
  assert.equal(parsed.sensors.IMU.validValues,5);
});

test('FlySight TRACK.CSV parser ignores empty numeric coordinates instead of converting them to zero', () => {
  const splitStart=ui.indexOf('function splitCsvLine(');
  const trackStart=ui.indexOf('function parseFlySightCsv(');
  const sensorStart=ui.indexOf('function parseFlySightSensorCsv(');
  const parseTrack=new Function(ui.slice(splitStart,trackStart)+ui.slice(trackStart,sensorStart)+';return parseFlySightCsv;')();
  const raw='$FLYS,2\r\n$COL,GNSS,ITOW,LAT,LON,HMSL,VELD\r\n$DATA\r\n$GNSS,1000,45,7,1200,5\r\n$GNSS,2000,,,1190,6\r\n';
  const points=parseTrack(raw);
  assert.equal(points.length,1);
  assert.equal(points[0].lat,45);
  assert.equal(points[0].lon,7);
});

test('FlySight import summary shows firmware and schema provenance', () => {
  assert.match(ui, /function flySightDeviceHtml\(info\)/);
  const start=ui.indexOf('function flySightDeviceHtml(');
  const end=ui.indexOf('function sensorSummaryHtml(',start);
  const render=new Function('esc',ui.slice(start,end)+';return flySightDeviceHtml;')(value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
  const html=render({firmwareVersion:'v2024.05.25',schemaVersion:'2'});
  assert.match(html,/Firmware v2024\.05\.25/);
  assert.match(html,/Data schema 2/);
});

test('FlySight sensor summary displays units and min/average/max without retaining raw sensor time series', () => {
  assert.match(ui, /function sensorSummaryHtml\(data\)/);
  assert.match(ui, /Minimum \/ average \/ maximum/);
  assert.match(ui, /sensor\.validValues\+' values'/);
  assert.match(ui, /sensor\.sampleRateHz!=null/);
  assert.match(ui, /sensor\.durationSeconds!=null/);
  assert.match(ui, /sensor\.missingValues\+' blank'/);
  const start=ui.indexOf('function sensorSummaryHtml(');
  const end=ui.indexOf('function trackSummaryHtml(',start);
  const renderSummary=new Function('esc',ui.slice(start,end)+';return sensorSummaryHtml;')(
    value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  );
  const html=renderSummary({sensors:{IMU:{headers:['acc_x'],units:['m/s2'],samples:2,validValues:2,missingValues:0,invalidValues:0,measurements:{acc_x:{min:1,average:2,max:3}}}}});
  assert.match(html, /acc_x · m\/s2/);
  assert.match(html, /1\.00 \/ 2\.00 \/ 3\.00/);
  assert.match(html, /2 samples/);
});

test('FlySight 2 metadata identifies matching track and sensor sessions and devices', () => {
  const splitStart=ui.indexOf('function splitCsvLine(');
  const metaStart=ui.indexOf('function parseFlySightMetadata(');
  const sensorStart=ui.indexOf('function parseFlySightSensorCsv(');
  const gpxStart=ui.indexOf('function parseFlySightGpx(');
  const source=ui.slice(splitStart,metaStart)+ui.slice(metaStart,sensorStart)+ui.slice(sensorStart,gpxStart);
  const parseMetadata=new Function(source+';return {parseFlySightMetadata,parseFlySightSensorCsv};')();
  const track='$FLYS,1\n$VAR,FIRMWARE_VER,v2024.05.25.pairing_request\n$VAR,DEVICE_ID,003e0038484e501420353131\n$VAR,SESSION_ID,3e10c2f6b1ea4604758b8926\n$COL,GNSS,time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,numSV\n$UNIT,GNSS,,deg,deg,m,m/s,m/s,m/s,m,m,m/s,\n$DATA\n$GNSS,2024-04-20T04:20:00.000Z,33.6568828,-117.7466357,630.077,-31.92,48.42,-34.93,136.117,170.718,4.74,4';
  const sensor='$FLYS,1\n$VAR,FIRMWARE_VER,v2024.05.25.pairing_request\n$VAR,DEVICE_ID,003e0038484e501420353131\n$VAR,SESSION_ID,3e10c2f6b1ea4604758b8926\n$COL,BARO,time,pressure,temperature\n$UNIT,BARO,s,Pa,deg C\n$COL,IMU,time,wx,wy,wz,ax,ay,az,temperature\n$UNIT,IMU,s,deg/s,deg/s,deg/s,g,g,g,deg C\n$DATA\n$IMU,59970.376,-0.427,1.770,1.953,-0.01464,-0.00732,0.94287,25.64\n$BARO,59970.376,101325,25.64';
  const tm=parseMetadata.parseFlySightMetadata(track),sm=parseMetadata.parseFlySightSensorCsv(sensor);
  const validatePair=new Function(source+';return validateFlySightPair;')();

  assert.equal(tm.sessionId,sm.metadata.sessionId);
  assert.equal(validatePair(tm,sm),true);
  assert.match(ui,/if\(!trackMetadata\)trackMetadata=trackDraft\?\.trackMetadata;if\(!sensorData&&trackDraft\?\.sensorData\)sensorData=trackDraft\.sensorData;validateFlySightPair\(trackMetadata,sensorData\)/);
  assert.equal(tm.deviceId,sm.metadata.deviceId);
  assert.equal(tm.firmwareVersion,'v2024.05.25.pairing_request');
  assert.equal(sm.sensors.IMU.samples,1);
  assert.equal(sm.sensors.BARO.samples,1);
  const mismatch=sensor.replace('3e10c2f6b1ea4604758b8926','different-session');
  assert.notEqual(tm.sessionId,parseMetadata.parseFlySightSensorCsv(mismatch).metadata.sessionId);
  assert.throws(()=>validatePair(tm,parseMetadata.parseFlySightSensorCsv(mismatch)),/SESSION_ID mismatch/);
  const otherDevice=sensor.replace('003e0038484e501420353131','other-device');
  assert.notEqual(tm.deviceId,parseMetadata.parseFlySightSensorCsv(otherDevice).metadata.deviceId);
  assert.throws(()=>validatePair(tm,parseMetadata.parseFlySightSensorCsv(otherDevice)),/DEVICE_ID mismatch/);
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
  assert.match(ui, /sensorSummaryHtml\(trackDraft\.sensorData\)/);
  assert.match(ui, /FlySight sensor summary/);
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
  assert.match(ui, /sensorSummaryHtml\(trackDraft\.sensorData\)/);
  assert.match(ui, /FlySight sensor summary/);
});


test('native FlySight browser navigates date/session folders and downloads full file paths', () => {
  assert.match(nativeFlySightBLE, /var isDirectory: Bool \{ attributes & 0x10 != 0 \}/);
  assert.match(nativeFlySightBLE, /listingPath/);
  assert.match(nativeFlySightBLE, /let fullPath = parent\.isEmpty \? "\/" \+ name : "\/" \+ parent \+ "\/" \+ name/);
  assert.match(nativeFlySightBLE, /var id: String \{ path \}/);
  assert.match(nativeFlySight, /currentDirectory = "\/"/);
  assert.match(nativeFlySight, /files\.filter\(\\\.isDirectory\)/);
  assert.match(nativeFlySight, /readDirectory\(folder\.path\)/);
  assert.match(nativeFlySight, /downloadFile\(path: file\.path/);
  assert.match(nativeFlySight, /Select files from one FlySight session only/);
  assert.match(nativeFlySight, /FlySight Imports/);
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
  assert.match(ui, /Number\(j\.flysightTrack\?\.stats\?\.points\)>0/);
  assert.match(ui, /Array\.isArray\(j\.flysightTrack\?\.trackPoints\)/);
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


test('FlySight iTOW millisecond values are normalized before timing calculations', () => {
  assert.match(ui, /timeKey==='itow'&&number\(row\[timeKey\]\)!==null\?String\(number\(row\[timeKey\]\)\/1000\)/);
  const timeSource = ui.match(/function trackTimeMs\(value\)\{[^\n]*\}/)?.[0];
  assert.ok(timeSource, 'trackTimeMs helper must exist');
  const trackTimeMs = new Function(timeSource + '; return trackTimeMs;')();
  assert.equal(trackTimeMs('345000'), 345000000);
  assert.equal(trackTimeMs('345001'), 345001000);
  assert.equal((trackTimeMs('345001') - trackTimeMs('345000')) / 1000, 1);
});

test('FlySight iTOW timestamps unwrap GPS-week rollover for continuous track timing', () => {
  assert.match(ui, /if\(timeKey==='itow'\)\{\s*let weekOffset=0,lastRaw=null/);
  assert.match(ui, /lastRaw-raw>302400\)weekOffset\+=604800/);
  assert.match(ui, /point\.time=String\(raw\+weekOffset\)/);
});

test('FlySight track summary reports GPS fix, satellite, accuracy and timing-gap quality metrics', () => {
  const timeSource=ui.match(/function trackTimeMs\(value\)\{[^\n]*\}/)?.[0];
  const start=ui.indexOf('function summarizeTrack(');
  const end=ui.indexOf('function renderAnalytics(',start);
  const summarizeSource=ui.slice(start,end);
  const summarize=new Function(timeSource+';'+summarizeSource+';return summarizeTrack;')();
  const result=summarize([
    {lat:0,lon:0,time:'2026-01-01T00:00:00Z',gpsfix:3,numsv:12,hacc:1.5,vacc:2},
    {lat:0,lon:0.001,time:'2026-01-01T00:00:01Z',gpsfix:3,numsv:10,hacc:2.5,vacc:3},
    {lat:0,lon:0.002,time:'2026-01-01T00:00:04Z',gpsfix:2,numsv:6,hacc:5,vacc:6}
  ]);
  assert.equal(result.gpsFixSamples,3);
  assert.equal(result.gpsFix3dPoints,2);
  assert.equal(result.averageSatellites,28/3);
  assert.equal(result.minimumSatellites,6);
  assert.equal(result.averageHorizontalAccuracyMeters,3);
  assert.equal(result.maxHorizontalAccuracyMeters,5);
  assert.equal(result.maxVerticalAccuracyMeters,6);
  assert.equal(result.gapsOverTwoSeconds,1);
  assert.match(ui, /function trackQualityHtml\(t\)/);
  assert.match(ui, /GPS data quality/);
});

test('FlySight maximum speed uses each segment distance, not cumulative distance', () => {
  const timeSource = ui.match(/function trackTimeMs\(value\)\{[^\n]*\}/)?.[0];
  const summaryStart=ui.indexOf('function summarizeTrack(');
  const summaryEnd=ui.indexOf('function renderAnalytics(',summaryStart);
  const summarySource=ui.slice(summaryStart,summaryEnd);
  assert.ok(timeSource && summarySource.includes('function summarizeTrack'), 'track timing and summary helpers must exist');
  const summarizeTrack = new Function(timeSource + ';' + summarySource + '; return summarizeTrack;')();
  const result = summarizeTrack([
    { lat: 0, lon: 0, time: '2026-01-01T00:00:00Z' },
    { lat: 0, lon: 0.001, time: '2026-01-01T00:00:01Z' },
    { lat: 0, lon: 0.003, time: '2026-01-01T00:00:02Z' }
  ]);
  assert.ok(result.distanceMeters > 330 && result.distanceMeters < 340);
  assert.ok(result.maxSpeedMps > 220 && result.maxSpeedMps < 225);
  assert.ok(result.durationSeconds === 2);
});


test('wind speed is recorded with an explicit unit and validates non-negative numeric values', () => {
  assert.match(ui, /field\('Wind speed \('\+\(j\.windUnit\|\|db\.settings\.windUnit\)\+'\)','windSpeed',j\.windSpeed\?\?''/);
  assert.match(ui, /id="windUnit" name="windUnit"/);
  assert.match(ui, /\['Wind speed',d\.windSpeed\]/);
  assert.match(ui, /windUnit:\'m\/s\'/);
});


test('FlySight receive path re-acknowledges duplicates within its eight-packet window', () => {
  assert.match(nativeFlySightBLE, /private var recentlyAcknowledgedCounters: \[UInt8\] = \[\]/);
  assert.match(nativeFlySightBLE, /recentlyAcknowledgedCounters\.contains\(counter\)/);
  assert.match(nativeFlySightBLE, /recentlyAcknowledgedCounters\.count > 8/);
  assert.match(nativeFlySightBLE, /expectedDownloadCounter = 0/);
  assert.doesNotMatch(nativeFlySightBLE, /if \(expectedDownloadCounter == nil\)/);
  assert.match(nativeFlySightBLE, /expectedDownloadCounter = counter &\+ 1/);
  assert.match(nativeFlySightBLE, /guard counter == expectedDownloadCounter/);
});

test('FlySight directory completion always stops timeout and keep-alive tasks', () => {
  const completion = nativeFlySightBLE.match(/private func finishDirectory\(_ result: Result<\[FlySightFile\], Error>\) \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.match(completion, /stopTransferTimers\(\)/);
  assert.match(completion, /directoryCompletion = nil/);
});


test('offline PWA falls back to the local logbook when the Auth CDN or API is unavailable', () => {
  assert.match(ui, /let neonAuth=null/);
  assert.match(ui, /await import\('https:\/\/esm\.sh\/@neondatabase\/auth'\)/);
  assert.match(ui, /function enterOfflineMode\(\)/);
  assert.match(ui, /if\(!auth\)\{enterOfflineMode\(\);return\}/);
  assert.match(ui, /Offline mode · records stay on this device/);
  assert.match(ui, /navigator\.onLine===false\|\|!error\.status\|\|error\.status>=500/);
});


test('service worker runtime caches the shell, preserves unrelated caches and serves offline navigation', async () => {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = {};
  const entries = new Map();
  const deleted = [];
  const cache = {
    async addAll(paths) { for (const path of paths) entries.set(path, new Response('shell:' + path)); },
    async put(key, response) { entries.set(typeof key === 'string' ? key : key.url, response); },
    async match(key) { return entries.get(typeof key === 'string' ? key : key.url) || null; }
  };
  const caches = {
    async open() { return cache; },
    async match(key) { return cache.match(key); },
    async keys() { return ['base-logbook-shell-old', 'unrelated-app-cache']; },
    async delete(key) { deleted.push(key); return true; }
  };
  const self = {
    location: { origin: 'https://logbook.test' },
    clients: { async claim() {} },
    async skipWaiting() {},
    addEventListener(type, listener) { listeners[type] = listener; }
  };
  runInNewContext(source, {
    self, caches, URL, Response,
    fetch: async () => { throw new Error('network offline'); }
  });

  let installTask;
  listeners.install({ waitUntil(task) { installTask = task; } });
  await installTask;
  assert.deepEqual([...entries.keys()].sort(), ['/', '/icons/base-logbook.svg', '/index.html', '/manifest.webmanifest'].sort());

  let activateTask;
  listeners.activate({ waitUntil(task) { activateTask = task; } });
  await activateTask;
  assert.deepEqual(deleted, ['base-logbook-shell-old']);

  let intercepted = false;
  listeners.fetch({
    request: { method: 'GET', url: 'https://logbook.test/api/health', mode: 'cors', destination: '' },
    respondWith() { intercepted = true; }
  });
  assert.equal(intercepted, false, 'API requests must bypass the app-shell cache');

  listeners.fetch({
    request: { method: 'POST', url: 'https://logbook.test/jumps', mode: 'cors', destination: '' },
    respondWith() { intercepted = true; }
  });
  assert.equal(intercepted, false, 'non-GET requests must bypass the app-shell cache');

  let navigationResponse;
  listeners.fetch({
    request: { method: 'GET', url: 'https://logbook.test/', mode: 'navigate', destination: 'document' },
    respondWith(task) { navigationResponse = task; }
  });
  const response = await navigationResponse;
  assert.equal(await response.text(), 'shell:/');
});
