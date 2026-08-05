# Reel Cut — Shorts Generator

Paste in one of **your own** long-form videos (or one you have explicit rights to reuse) and get back 10–20 vertical short clips of the strongest moments, each with a caption, hashtags, and a credit line — ready to post.

## Why the ownership checkbox exists

This tool is built for repurposing your **own** content (or content you have explicit permission for). Downloading and reposting other creators' videos — even with credit — is copyright infringement, and YouTube's Content ID system doesn't treat a credit line as a license. The app enforces this at the API level: `ownershipConfirmed` must be `true` or the backend rejects the job before anything is downloaded or processed (see `src/routes/jobs.js` and `src/workers/jobProcessor.js`).

If you later want to extend this to other creators' content, the only safe paths are (a) a real license/permission from the creator, or (b) building real transformative commentary on top of the clip (fair use), not just re-cutting and reposting — and even that carries some risk.

## How it works

1. **Ingest** — `youtube-dl-exec` downloads your video, or you upload a file
   directly (`src/services/downloader.js`, `src/middleware/upload.js`).
2. **Transcribe** — Groq's hosted Whisper (`whisper-large-v3`) produces a
   timestamped transcript (`src/services/transcriber.js`).
3. **Analyze** — Groq's Llama (`llama-3.3-70b-versatile`) reads the
   transcript and picks 10–20 self-contained "best moments," writing a
   caption and hashtags for each (`src/services/analyzer.js`).
4. **Clip** — ffmpeg cuts each moment into a vertical 9:16 clip. The full
   source frame is scaled to fit entirely inside the canvas (nothing is
   cropped off), a blurred/darkened copy of the same footage fills the
   space around it instead of plain black bars, and the caption + credit
   line are burned in with wrapped text, drop shadows, and a light frame
   for contrast (`src/services/clipper.js`).
5. **Serve** — the frontend polls job status and lets you preview/download
   each finished clip.

### Clip design

`renderClip()` in `src/services/clipper.js` builds an ffmpeg
`filter_complex` that composites each clip like this:

- the source video is split into a **background** (cover-cropped, blurred,
  darkened) and a **foreground** (scaled to fit the full frame with
  nothing cut off — landscape, portrait, and square sources all work)
- the foreground is centered over the background, filling the vertical
  9:16 canvas
- **nothing else is drawn into the frame** — no title, caption, credit
  line, border, or scrim is burned into the video. The clip file itself is
  just the source footage, reframed.
- `CLIP_WIDTH` / `CLIP_HEIGHT` / `CLIP_VIDEO_PRESET` / `CLIP_VIDEO_CRF` in
  `.env` control the look (see `.env.example`)
- captions and hashtags are still generated per clip by the analyzer (see
  below) and returned as metadata on each `Clip` document — surfaced in
  the UI as "Caption for posting" (with a copy button) for you to paste
  into the post text when you publish the clip, not composited onto the
  video itself

## Project layout

```
backend/
  server.js                 Express app entry point
  src/
    config/db.js             MongoDB connection
    models/Job.js            Job document (status, source, ownership flag)
    models/Clip.js           Clip document (timestamps, caption, hashtags, file)
    routes/jobs.js           REST API: create jobs, poll status, download clips
    services/downloader.js   yt-dlp wrapper
    services/transcriber.js  Whisper transcription
    services/analyzer.js     LLM best-moment detection + caption/hashtag generation
    services/clipper.js      ffmpeg cutting + vertical reframing (no text burn-in)
    workers/jobProcessor.js  Orchestrates the full pipeline per job
    middleware/upload.js     multer config for direct file uploads
frontend/
  src/
    pages/Home.jsx           Submit form (URL or upload) + ownership checkbox
    pages/JobStatus.jsx      Polls job progress, renders finished clips
    components/ClipCard.jsx  Single clip preview + download
    api/client.js            Axios wrapper for the backend API
```

## Running it locally

### Prerequisites
- Node.js 18+
- MongoDB running locally (or a connection string, e.g. MongoDB Atlas)
- `ffmpeg` installed and on your PATH (required by `fluent-ffmpeg`)
- A Groq API key (used for Whisper transcription + Llama analysis) — get one at console.groq.com

### Backend
```bash
cd backend
cp .env.example .env      # fill in MONGO_URI and GROQ_API_KEY
npm install
npm run dev                # http://localhost:5000
```

### Frontend
```bash
cd frontend
npm install
npm run dev                # http://localhost:5173
```

The Vite dev server proxies `/api` requests to `http://localhost:5000`
(see `vite.config.js`), so just open the frontend URL and go.

## Deploying: MongoDB connection

`src/config/db.js` is set up for production, not just local dev:

- Retries the initial connection (`MONGO_MAX_RETRIES`, `MONGO_RETRY_DELAY_MS`)
  instead of crashing on the first blip — useful when the app and DB start up
  at slightly different times in a deploy.
- Connection pooling via `MONGO_MAX_POOL_SIZE` / `MONGO_MIN_POOL_SIZE`.
- Logs `connected` / `disconnected` / `reconnected` / `error` events so
  connection issues show up in your platform's logs.
- Skips `autoIndex` when `NODE_ENV=production` (index builds shouldn't run on
  every boot in prod — run `Model.syncIndexes()` as a one-off deploy step
  instead if you change indexes).
- `server.js` closes the Mongo connection cleanly on `SIGINT`/`SIGTERM`, so
  container restarts and redeploys don't leave connections hanging.

**To point this at a real database:**
1. Create a cluster (MongoDB Atlas is the easiest managed option).
2. Add a database user and, in Atlas, allow network access from your
   deployment platform's IPs (or `0.0.0.0/0` while testing, tightened later).
3. Copy the `mongodb+srv://...` connection string into `MONGO_URI` in your
   deployment platform's environment variables — not into a committed `.env`
   file.
4. Set `NODE_ENV=production`.

## Source video cleanup

Once a job's clips finish rendering, `workers/jobProcessor.js` deletes the
downloaded/uploaded source video from disk and clears `sourceFilePath` /
`workingFilePath` on the `Job` document (`sourceFileRemoved` flips to `true`,
`sourceFileRemovedAt` records when). Only the source video is removed — the
job record and its rendered clips stay in the DB. This keeps `storage/` from
filling up with full-length videos once they've served their purpose.

## Notes / next steps if you take this further

- **Queue**: jobs currently run in-process (`processJob` is fire-and-forget
  from the route handler). For real traffic, swap this for BullMQ + Redis so
  a server restart doesn't drop in-flight jobs.
- **Storage**: clips/downloads/uploads are written to local disk
  (`backend/storage/`). For deployment, point these at S3 or similar.
- **Auth**: there's no user/auth layer yet — every job is anonymous. You'll
  want accounts if this becomes multi-user, so credit lines and ownership
  confirmations are tied to a real identity.
- **Costs**: Groq's Whisper + Llama calls cost money per video (Groq is
  usually cheaper/faster than OpenAI, but still not free) — consider caching
  transcripts and adding a max video-length guard.