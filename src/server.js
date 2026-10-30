import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import pg from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8787);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : { rejectUnauthorized: false }, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => cb(null, /^(audio\/(webm|wav|mpeg|mp4|ogg|mpga|m4a|x-m4a)|video\/webm)$/.test(file.mimetype)) });
const jwksUrl = process.env.NEON_AUTH_JWKS_URL;
const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : false, credentials: true }));
app.use(express.json({ limit: '5mb' }));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function requireUser(req, res, next) {
  try {
    if (!jwks) return res.status(503).json({ error: 'Authentication is not configured. Set NEON_AUTH_JWKS_URL and NEON_AUTH_ISSUER.' });
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in required.' });
    // Verify the signature, expiry and configured issuer. If an issuer is
    // configured, a token from another Neon Auth project must not be accepted.
    let payload;
    try {
      ({ payload } = await jwtVerify(header.slice(7), jwks, process.env.NEON_AUTH_ISSUER ? { issuer: process.env.NEON_AUTH_ISSUER } : {}));
    } catch (e) {
      console.error('Neon Auth JWT verification failed', { name: e?.name, code: e?.code, message: e?.message, issuerConfigured: Boolean(process.env.NEON_AUTH_ISSUER) });
      return res.status(401).json({ error: 'Session token could not be verified.', code: e?.code || 'JWT_INVALID' });
    }
    if (!payload.sub || typeof payload.sub !== 'string') return res.status(401).json({ error: 'Token has no user identity.' });
    req.user = { id: payload.sub };
    try {
      await pool.query('INSERT INTO app_users(id) VALUES($1) ON CONFLICT (id) DO NOTHING', [req.user.id]);
    } catch (e) {
      console.error('User bootstrap database error', { code: e?.code, message: e?.message });
      return res.status(503).json({ error: 'Account database is temporarily unavailable.' });
    }
    next();
  } catch (e) {
    console.error('Authentication middleware error', { name: e?.name, code: e?.code, message: e?.message });
    return res.status(500).json({ error: 'Authentication service error.' });
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'base-jump-logbook-api', voiceExtraction: Boolean(process.env.OPENAI_API_KEY), authConfigured: Boolean(jwks) }));
app.get('/api/me', requireUser, (req, res) => res.json({ userId: req.user.id }));

const objectSchema = z.object({ name: z.string().trim().min(1).max(160), country: z.string().max(100).optional().nullable(), latitude: z.number().min(-90).max(90).optional().nullable(), longitude: z.number().min(-180).max(180).optional().nullable(), height_m: z.number().nonnegative().max(100000).optional().nullable(), object_type: z.enum(['B','A','S','E','Other']), object_type_other: z.string().max(160).optional().nullable(), metadata: z.record(z.string(), z.unknown()).optional() }).refine(v => v.object_type !== 'Other' || Boolean(v.object_type_other?.trim()), { message: 'Specify object type when Other is selected.', path: ['object_type_other'] });
const gearSchema = z.object({ name: z.string().trim().min(1).max(100), rig: z.string().max(160).optional().nullable(), suit: z.string().max(160).optional().nullable(), pilot_chute: z.string().max(160).optional().nullable(), slider_configuration: z.string().max(160).optional().nullable(), metadata: z.record(z.string(), z.unknown()).optional() });
const uuidParam = z.string().uuid();
const jumpSchema = z.object({ object_id: z.string().uuid().optional().nullable(), object_name: z.string().max(160).optional().nullable(), country: z.string().max(100).optional().nullable(), latitude: z.number().min(-90).max(90).optional().nullable(), longitude: z.number().min(-180).max(180).optional().nullable(), date_time: z.string().datetime({ offset: true }).optional().nullable(), height_m: z.number().nonnegative().max(100000).optional().nullable(), object_type: z.enum(['B','A','S','E','Other']).optional().nullable(), object_type_other: z.string().max(160).optional().nullable(), slider_configuration: z.string().max(160).optional().nullable(), pilot_chute: z.string().max(160).optional().nullable(), suit: z.string().max(160).optional().nullable(), summit_osp: z.string().max(30).optional().nullable(), rig: z.string().max(160).optional().nullable(), jump_type: z.string().max(160).optional().nullable(), wind_strength: z.number().nonnegative().max(200).optional().nullable(), wind_direction: z.string().max(80).optional().nullable(), delay_seconds: z.number().nonnegative().max(3600).optional().nullable(), delay_for_su_seconds: z.number().nonnegative().max(3600).optional().nullable(), exit_manoeuvre: z.string().max(200).optional().nullable(), off_heading: z.boolean().optional().nullable(), correction: z.boolean().optional().nullable(), brake_setting: z.string().max(160).optional().nullable(), sky_cover: z.string().max(80).optional().nullable(), lighting: z.string().max(80).optional().nullable(), private_notes: z.string().max(12000).optional().nullable(), beautiful_people_around: z.string().max(2000).optional().nullable(), deployment_method: z.string().max(120).optional().nullable(), opening_direction_degrees: z.number().int().min(0).max(180).optional().nullable(), opening_direction_side: z.enum(['L','R','C']).optional().nullable(), extra_fields: z.record(z.string(), z.unknown()).optional() }).refine(v => v.object_type !== 'Other' || Boolean(v.object_type_other?.trim()), { message: 'Specify object type when Other is selected.', path: ['object_type_other'] });

app.get('/api/objects', requireUser, asyncRoute(async (req,res) => { const r=await pool.query('SELECT * FROM objects WHERE user_id=$1 ORDER BY name', [req.user.id]); res.json(r.rows); }));
app.post('/api/objects', requireUser, asyncRoute(async (req,res) => { const v=objectSchema.parse(req.body); const r=await pool.query(`INSERT INTO objects(user_id,name,country,latitude,longitude,height_m,object_type,object_type_other,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.user.id,v.name,v.country??null,v.latitude??null,v.longitude??null,v.height_m??null,v.object_type,v.object_type_other??null,v.metadata??{}]); res.status(201).json(r.rows[0]); }));
const objectPatchSchema = z.object(objectSchema.shape).partial();
app.patch('/api/objects/:id', requireUser, asyncRoute(async (req,res) => { const v=objectPatchSchema.parse(req.body); if(v.object_type==='Other' && !String(v.object_type_other||'').trim()) return res.status(400).json({error:'Specify object type when Other is selected.'}); const entries=Object.entries(v); if(!entries.length) return res.status(400).json({error:'No fields supplied.'}); const sets=entries.map(([k],i)=>`${k}=$${i+3}`).join(','); const r=await pool.query(`UPDATE objects SET ${sets}, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,[req.params.id,req.user.id,...entries.map(([,value])=>value)]); if(!r.rowCount) return res.status(404).json({error:'Object not found.'}); res.json(r.rows[0]); }));
app.delete('/api/objects/:id', requireUser, asyncRoute(async (req,res) => { const r=await pool.query('DELETE FROM objects WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,req.user.id]); if(!r.rowCount) return res.status(404).json({error:'Object not found.'}); res.status(204).end(); }));
app.get('/api/gear', requireUser, asyncRoute(async (req,res) => { const r=await pool.query('SELECT * FROM gear_presets WHERE user_id=$1 ORDER BY name', [req.user.id]); res.json(r.rows); }));
app.post('/api/gear', requireUser, asyncRoute(async (req,res) => { const v=gearSchema.parse(req.body); const r=await pool.query(`INSERT INTO gear_presets(user_id,name,rig,suit,pilot_chute,slider_configuration,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.user.id,v.name,v.rig??null,v.suit??null,v.pilot_chute??null,v.slider_configuration??null,v.metadata??{}]); res.status(201).json(r.rows[0]); }));
app.patch('/api/gear/:id', requireUser, asyncRoute(async (req,res) => { const v=gearSchema.partial().parse(req.body); const entries=Object.entries(v); if(!entries.length) return res.status(400).json({error:'No fields supplied.'}); const sets=entries.map(([k],i)=>`${k}=$${i+3}`).join(','); const r=await pool.query(`UPDATE gear_presets SET ${sets}, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,[req.params.id,req.user.id,...entries.map(([,value])=>value)]); if(!r.rowCount) return res.status(404).json({error:'Gear preset not found.'}); res.json(r.rows[0]); }));
app.delete('/api/gear/:id', requireUser, asyncRoute(async (req,res) => { const r=await pool.query('DELETE FROM gear_presets WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,req.user.id]); if(!r.rowCount) return res.status(404).json({error:'Gear preset not found.'}); res.status(204).end(); }));

const jumpColumns = ['object_id','object_name','country','latitude','longitude','date_time','height_m','object_type','object_type_other','slider_configuration','pilot_chute','suit','summit_osp','rig','jump_type','wind_strength','wind_direction','delay_seconds','delay_for_su_seconds','exit_manoeuvre','off_heading','correction','brake_setting','sky_cover','lighting','private_notes','beautiful_people_around','deployment_method','opening_direction_degrees','opening_direction_side','extra_fields'];
app.get('/api/jumps', requireUser, asyncRoute(async (req,res) => { const r=await pool.query('SELECT * FROM jumps WHERE user_id=$1 ORDER BY jump_number DESC LIMIT 1000',[req.user.id]); res.json(r.rows); }));
app.post('/api/jumps', requireUser, asyncRoute(async (req,res) => { const v=jumpSchema.parse(req.body); const client=await pool.connect(); try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[req.user.id]); const n=await client.query('SELECT COALESCE(MAX(jump_number),0)+1 AS n FROM jumps WHERE user_id=$1',[req.user.id]); const values=jumpColumns.map(k=>v[k]??null); const cols=['user_id','jump_number',...jumpColumns]; const params=[req.user.id,Number(n.rows[0].n),...values]; const placeholders=params.map((_,i)=>`$${i+1}`).join(','); const r=await client.query(`INSERT INTO jumps(${cols.join(',')}) VALUES(${placeholders}) RETURNING *`,params); await client.query('COMMIT'); res.status(201).json(r.rows[0]); } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); } }));
app.patch('/api/jumps/:id', requireUser, asyncRoute(async (req,res) => { const id=uuidParam.parse(req.params.id); const v=z.object(jumpSchema.shape).partial().parse(req.body); if(v.object_type==='Other' && !String(v.object_type_other||'').trim()) return res.status(400).json({error:'Specify object type when Other is selected.'}); const entries=Object.entries(v); if(!entries.length) return res.status(400).json({error:'No fields supplied.'}); const sets=entries.map(([k],i)=>`${k}=$${i+3}`).join(','); const r=await pool.query(`UPDATE jumps SET ${sets}, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,[id,req.user.id,...entries.map(([,v])=>v)]); if(!r.rowCount) return res.status(404).json({error:'Jump not found.'}); res.json(r.rows[0]); }));
app.delete('/api/jumps/:id', requireUser, asyncRoute(async (req,res) => { const id=uuidParam.parse(req.params.id); const r=await pool.query('DELETE FROM jumps WHERE id=$1 AND user_id=$2 RETURNING id',[id,req.user.id]); if(!r.rowCount) return res.status(404).json({error:'Jump not found.'}); res.status(204).end(); }));

const customOptionSchema = z.object({ field_key:z.string().trim().min(1).max(80), label:z.string().trim().min(1).max(160) });
app.get('/api/custom-options', requireUser, asyncRoute(async (req,res) => { const r=await pool.query('SELECT id,field_key,label,created_at FROM custom_options WHERE user_id=$1 ORDER BY field_key,label',[req.user.id]); res.json(r.rows); }));
app.post('/api/custom-options', requireUser, asyncRoute(async (req,res) => { const v=customOptionSchema.parse(req.body); const r=await pool.query('INSERT INTO custom_options(user_id,field_key,label) VALUES($1,$2,$3) ON CONFLICT(user_id,field_key,label) DO UPDATE SET label=EXCLUDED.label RETURNING id,field_key,label,created_at',[req.user.id,v.field_key,v.label]); res.status(201).json(r.rows[0]); }));
app.delete('/api/custom-options/:id', requireUser, asyncRoute(async (req,res) => { const r=await pool.query('DELETE FROM custom_options WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,req.user.id]); if(!r.rowCount) return res.status(404).json({error:'Custom option not found.'}); res.status(204).end(); }));

const voiceFields = {
  type: 'object', additionalProperties: false,
  properties: {
    object_name:{type:['string','null']}, country:{type:['string','null']}, latitude:{type:['number','null']}, longitude:{type:['number','null']}, height_m:{type:['number','null']}, object_type:{type:['string','null'],enum:['B','A','S','E','Other',null]}, object_type_other:{type:['string','null']}, date_time:{type:['string','null']}, slider_configuration:{type:['string','null']}, pilot_chute:{type:['string','null']}, suit:{type:['string','null']}, summit_osp:{type:['string','null']}, rig:{type:['string','null']}, jump_type:{type:['string','null']}, wind_strength:{type:['number','null']}, wind_direction:{type:['string','null']}, delay_seconds:{type:['number','null']}, delay_for_su_seconds:{type:['number','null']}, exit_manoeuvre:{type:['string','null']}, off_heading:{type:['boolean','null']}, correction:{type:['boolean','null']}, brake_setting:{type:['string','null']}, sky_cover:{type:['string','null']}, lighting:{type:['string','null']}, private_notes:{type:['string','null']}, beautiful_people_around:{type:['string','null']}, deployment_method:{type:['string','null']}, opening_direction_degrees:{type:['integer','null']}, opening_direction_side:{type:['string','null'],enum:['L','R','C',null]}, uncertain_fields:{type:'array',items:{type:'string'}}, transcript:{type:'string'}
  }, required:['object_name','country','latitude','longitude','height_m','object_type','object_type_other','date_time','slider_configuration','pilot_chute','suit','summit_osp','rig','jump_type','wind_strength','wind_direction','delay_seconds','delay_for_su_seconds','exit_manoeuvre','off_heading','correction','brake_setting','sky_cover','lighting','private_notes','beautiful_people_around','deployment_method','opening_direction_degrees','opening_direction_side','uncertain_fields','transcript']
};
app.post('/api/voice/extract', requireUser, upload.single('audio'), asyncRoute(async (req,res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({error:'AI voice extraction is not configured. Set OPENAI_API_KEY on the server.'});
  if (!req.file) return res.status(400).json({error:'Attach an audio recording in the audio field.'});
  const form = new FormData(); form.append('file', new Blob([req.file.buffer], {type:req.file.mimetype}), req.file.originalname || 'jump-audio.webm'); form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
  const transcribe = await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form});
  if(!transcribe.ok) { const detail=await transcribe.text(); console.error('Transcription provider error',transcribe.status,detail.slice(0,500)); return res.status(502).json({error:'Speech transcription failed. No jump was saved.'}); }
  const {text:transcript=''}=await transcribe.json();
  const instructions = `Extract a draft BASE jump logbook record from the transcript. Return only fields explicitly stated or unambiguously spoken. Never infer missing values. Unknown values must be null and their field keys added to uncertain_fields only if the speaker attempted to provide them but recognition is ambiguous. Leave absent fields null without marking uncertain. Convert heights to meters only when unit is stated or clearly implied; wind strength to m/s only if unit stated; delay to seconds. Map object category to B/A/S/E/Other only when clear; if Other, require object_type_other. Dates must be ISO 8601 with timezone only when known; otherwise return a date string without inventing a timezone. Do not interpret safety-critical or technical ambiguity as certainty. Transcript: ${transcript}`;
  const extract = await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_EXTRACT_MODEL||'gpt-4.1-mini',instructions,input:instructions,text:{format:{type:'json_schema',name:'base_jump_draft',strict:true,schema:voiceFields}}})});
  if(!extract.ok){const detail=await extract.text();console.error('Extraction provider error',extract.status,detail.slice(0,500));return res.status(502).json({error:'AI field extraction failed. Transcript was not saved.'});}
  const payload=await extract.json(); const outputText=(payload.output||[]).flatMap(o=>o.content||[]).find(c=>c.type==='output_text')?.text;
  if(!outputText) return res.status(502).json({error:'AI returned no structured draft.'});
  const draft=JSON.parse(outputText); draft.transcript=transcript;
  // Intentionally return a draft only. This endpoint never writes a jump to the database.
  res.json({draft,requiresConfirmation:true,storedAudio:false});
}));


const snapshotSchema = z.object({ jumps: z.array(z.record(z.string(), z.unknown())).max(10000), objects: z.array(z.record(z.string(), z.unknown())).max(5000), gears: z.array(z.record(z.string(), z.unknown())).max(5000), options: z.record(z.string(), z.array(z.string())).optional(), settings: z.record(z.string(), z.unknown()).optional() }).strict();
app.get('/api/snapshot', requireUser, asyncRoute(async (req,res) => {
  const r = await pool.query('SELECT payload, updated_at FROM user_snapshots WHERE user_id=$1', [req.user.id]);
  res.json({ snapshot: r.rows[0]?.payload || null, updatedAt: r.rows[0]?.updated_at || null });
}));
app.put('/api/snapshot', requireUser, asyncRoute(async (req,res) => {
  const body = z.object({ ...snapshotSchema.shape, expectedUpdatedAt: z.string().datetime({ offset:true }).nullable().optional() }).strict().parse(req.body);
  const { expectedUpdatedAt = null, ...snapshot } = body;
  const r = await pool.query(
    'INSERT INTO user_snapshots(user_id,payload,updated_at) VALUES($1,$2::jsonb,date_trunc('milliseconds',now())) ON CONFLICT(user_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=date_trunc('milliseconds',now()) WHERE user_snapshots.updated_at=$3::timestamptz RETURNING updated_at',
    [req.user.id, JSON.stringify(snapshot), expectedUpdatedAt]
  );
  if (!r.rowCount) {
    const current = await pool.query('SELECT updated_at FROM user_snapshots WHERE user_id=$1', [req.user.id]);
    return res.status(409).json({ error:'Cloud data changed on another device. Sync paused to protect both copies.', code:'SNAPSHOT_CONFLICT', updatedAt:current.rows[0]?.updated_at || null });
  }
  res.json({ ok:true, updatedAt:r.rows[0].updated_at });
}));

app.use((err, _req, res, _next) => {
  if (err instanceof z.ZodError) return res.status(400).json({error:'Validation failed.', details:err.issues.map(i=>({field:i.path.join('.'),message:i.message}))});
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({error:'Audio file must be 20 MB or smaller.'});
  console.error(err); res.status(500).json({error:'Unexpected server error.'});
});

if (process.env.VERCEL !== '1') app.listen(port, () => console.log(`BASE Jump Logbook API listening on :${port}`));

export default app;
