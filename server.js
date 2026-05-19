/**
 * Voice Intelligence — Speech-to-Text backend (thin proxy).
 *
 * One job: receive an audio blob from the Salesforce LWC, forward it to
 * Groq Whisper (multipart — trivial and 100% reliable in Node), return
 * { text }. No database, no state. Free to host (Render free tier / etc.).
 *
 * Env vars:
 *   GROQ_API_KEY   (required)  your existing free Groq key (gsk_...)
 *   GROQ_MODEL     (optional)  default: whisper-large-v3-turbo
 *   ALLOWED_ORIGIN (optional)  CSV of allowed origins; default: reflect any
 *   PORT           (optional)  Render sets this automatically
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';
const PORT = process.env.PORT || 3000;
const ALLOWED = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
// Optional shared secret. If set, server-side (Apex) callers must send it as
// the x-ingest-token header. Leave unset for the simplest possible setup.
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';

const app = Fastify({ logger: true, bodyLimit: 35 * 1024 * 1024 });

// Shared: send a Buffer of audio to Groq Whisper, return transcript text.
async function groqTranscribe(buf, mimetype, filename, lang) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimetype || 'audio/webm' }), filename || 'audio.webm');
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'json');
  if (lang) form.append('language', lang);

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form
  });
  const bodyText = await r.text();
  if (!r.ok) {
    const err = new Error(`Groq ${r.status}: ${bodyText.slice(0, 600)}`);
    err.status = r.status;
    throw err;
  }
  try { return (JSON.parse(bodyText).text || '').trim(); }
  catch { return ''; }
}

await app.register(cors, {
  // Reflect the request origin unless an explicit allow-list is configured.
  origin: ALLOWED.length ? ALLOWED : true,
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-language']
});
await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });

// Uptime ping target (keeps the free dyno warm — point a free cron at this).
app.get('/health', async () => ({ ok: true, ts: Date.now() }));

/**
 * Server-to-server endpoint. Salesforce Apex (orchestrator) calls this via a
 * Named Credential with a base64 audio payload — no device fetch, no CORS,
 * no multipart in Apex. This is the reliable mobile path.
 *
 * POST /transcribe-json
 *   body:    { "audioBase64": "...", "fileName": "audio.webm", "language": "en" }
 *   header:  x-ingest-token: <token>   (only if INGEST_TOKEN env is set)
 *   200:     { "text": "the transcript" }
 */
app.post('/transcribe-json', async (req, reply) => {
  if (!GROQ_API_KEY) {
    return reply.code(500).send({ error: 'Server misconfigured: GROQ_API_KEY not set' });
  }
  if (INGEST_TOKEN && req.headers['x-ingest-token'] !== INGEST_TOKEN) {
    return reply.code(401).send({ error: 'Invalid or missing x-ingest-token' });
  }
  const b = req.body || {};
  if (!b.audioBase64) {
    return reply.code(400).send({ error: 'audioBase64 is required' });
  }
  let buf;
  try {
    buf = Buffer.from(b.audioBase64, 'base64');
  } catch {
    return reply.code(400).send({ error: 'audioBase64 is not valid base64' });
  }
  if (!buf.length) {
    return reply.code(400).send({ error: 'Empty audio' });
  }
  const lang = (b.language || '').toString();
  const lang2 = lang.includes('-') ? lang.split('-')[0] : lang;
  const fileName = b.fileName || 'audio.webm';
  const mime =
    fileName.endsWith('.m4a') || fileName.endsWith('.mp4') ? 'audio/mp4' :
    fileName.endsWith('.mp3') ? 'audio/mpeg' :
    fileName.endsWith('.wav') ? 'audio/wav' :
    fileName.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm';

  try {
    const text = await groqTranscribe(buf, mime, fileName, lang2);
    return reply.send({ text });
  } catch (e) {
    req.log.error(e);
    return reply.code(e.status && e.status >= 400 && e.status < 600 ? e.status : 502)
      .send({ error: 'Transcription failed', detail: String(e.message || e).slice(0, 600) });
  }
});

app.post('/transcribe', async (req, reply) => {
  if (!GROQ_API_KEY) {
    return reply.code(500).send({ error: 'Server misconfigured: GROQ_API_KEY not set' });
  }

  const data = await req.file();              // multipart field name: "file"
  if (!data) {
    return reply.code(400).send({ error: 'No audio file in request (expected field "file")' });
  }
  const buf = await data.toBuffer();
  if (!buf || buf.length === 0) {
    return reply.code(400).send({ error: 'Empty audio' });
  }

  const langRaw = (req.headers['x-language'] || '').toString();
  const lang = langRaw.includes('-') ? langRaw.split('-')[0] : langRaw;

  try {
    const text = await groqTranscribe(buf, data.mimetype, data.filename, lang);
    return reply.send({ text });
  } catch (e) {
    req.log.error(e);
    return reply.code(e.status && e.status >= 400 && e.status < 600 ? e.status : 502)
      .send({ error: 'Transcription failed', detail: String(e.message || e).slice(0, 600) });
  }
});

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`STT backend listening on :${PORT}`))
  .catch((err) => { app.log.error(err); process.exit(1); });
