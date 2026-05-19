# Voice Intelligence — STT Backend

Thin, stateless proxy. Receives an audio blob from the Salesforce LWC and
forwards it to **Groq Whisper** (`whisper-large-v3-turbo`), returning the
transcript text. No database, no auth state. Free to host.

```
Mobile/Desktop LWC  --(HTTPS multipart)-->  this service  --(multipart)-->  Groq Whisper
                                  <-- { "text": "..." } --
```

## Endpoints

| Method | Path         | Purpose                                            |
|--------|--------------|----------------------------------------------------|
| GET    | `/health`    | Uptime ping (keep the free dyno warm)              |
| POST   | `/transcribe`| multipart field `file` + optional `x-language` hdr |

`POST /transcribe` → `200 { "text": "the transcript" }`

## Local run

```bash
cd backend
npm install
cp .env.example .env      # put your real GROQ_API_KEY in .env
npm start                 # http://localhost:3000/health
```

## Deploy to Render (free, no credit card)

1. Push this repo (or just the `backend/` folder) to GitHub.
2. https://render.com → sign up (free) → **New → Web Service**.
3. Connect the repo. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. **Environment** → add:
   - `GROQ_API_KEY` = your existing `gsk_...` key
   - (optional) `GROQ_MODEL` = `whisper-large-v3-turbo`
   - (optional) `ALLOWED_ORIGIN` = your `https://xxxxx.lightning.force.com`
5. Create Web Service. You get a URL like `https://voice-stt-backend.onrender.com`.
6. Test it: open `https://<your-url>/health` → should return `{"ok":true,...}`.

### Keep it warm (avoid 30-60s cold starts)

Render's free tier sleeps after 15 min idle. Add a free pinger:
- https://cron-job.org (free, no card) → new cron job → URL = `https://<your-url>/health`,
  interval every 10 minutes. Done — the service stays responsive.

## Wire it into Salesforce

1. **CSP Trusted Site** — Setup → Security → **CSP Trusted Sites** → New:
   - Trusted Site Name: `VoiceSTTBackend`
   - URL: `https://<your-render-url>` (no trailing slash)
   - Active: ✅, Context: **All**
   - Under "CSP Directives" enable **connect-src** (allow `connect-src`).
2. **Set the URL on the component** — open the record page in Lightning App
   Builder, select the **Voice Conversations** component, paste
   `https://<your-render-url>` into the **STT Backend URL** property. Save.

That's it. On mobile (no browser speech recognition) the LWC sends the audio
to this service, gets the transcript, and the existing analysis pipeline runs
unchanged.

## Cost

$0. Groq Whisper free tier (per-account limits, no card) + Render free tier.
