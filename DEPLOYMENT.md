# Deploying: Backend on Render, Frontend on Vercel

This app has two moving parts to deploy separately:
- **Backend** (Express + MongoDB + ffmpeg + yt-dlp) → **Render** (as a Docker web service)
- **Frontend** (Vite + React static build) → **Vercel**

## What changed to make this deploy-ready

- `backend/Dockerfile` — Render's native Node runtime doesn't have `ffmpeg` or
  `python3` installed, both of which this app needs at runtime (`fluent-ffmpeg`
  shells out to `ffmpeg`; the `yt-dlp` binary `youtube-dl-exec` installs needs
  `python3`). The Dockerfile installs both via `apt`.
- `render.yaml` — optional one-click Blueprint that provisions the backend
  service, a persistent disk, and lists every env var you need to fill in.
- `backend/server.js` — CORS now reads a **comma-separated list** from
  `CLIENT_ORIGIN`, so you can allow both your Vercel production domain and
  `localhost` at once.
- `backend/.env.example` — removed duplicate/conflicting clip-length keys
  that were in the original file.
- `frontend/src/api/client.js` — the API base URL is now
  `import.meta.env.VITE_API_URL` (falls back to `/api` for local dev). Vercel
  doesn't proxy `/api` to another host the way the Vite dev server does, so
  the frontend needs to know the full Render backend URL in production.
- `frontend/vercel.json` — SPA rewrite so refreshing `/jobs/:jobId` doesn't
  404 (this is a client-side-routed React app).

## Prerequisites

- A GitHub repo with this code pushed (Render and Vercel both deploy from git).
- A [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) cluster (free tier is fine to start).
- A [Groq](https://console.groq.com) API key.
- A [Render](https://render.com) account and a [Vercel](https://vercel.com) account.

---

## Step 1 — Push this code to GitHub

```bash
cd Reel-Generator-main
git init
git add .
git commit -m "Deploy-ready: Render backend + Vercel frontend"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## Step 2 — Set up MongoDB Atlas

1. Create a free cluster at Atlas.
2. **Database Access** → add a database user with a password.
3. **Network Access** → add `0.0.0.0/0` (Render's outbound IPs aren't static
   on most plans, so this is the practical option; you can restrict later if
   you upgrade to a plan with static IPs).
4. **Connect → Drivers** → copy the `mongodb+srv://...` connection string.
   You'll paste this into Render in Step 3 — don't put it in a committed file.

## Step 3 — Deploy the backend to Render

### Option A: Blueprint (uses `render.yaml`, fastest)

1. In Render, click **New → Blueprint**, connect your GitHub repo, and pick it.
2. Render reads `render.yaml` and proposes a `reel-generator-backend` web
   service (Docker, using `backend/Dockerfile`) plus a 5GB persistent disk
   mounted at `/app/storage`.
3. Before deploying, fill in the env vars marked `sync: false`:
   - `MONGO_URI` — your Atlas connection string from Step 2
   - `GROQ_API_KEY` — your Groq key
   - `CLIENT_ORIGIN` — leave a placeholder like `http://localhost:5173` for
     now; you'll update it in Step 5 once you know your Vercel URL
4. Click **Apply**. First build takes a few minutes (installing ffmpeg).

### Option B: Manual web service

1. **New → Web Service**, connect the repo.
2. **Root Directory**: `backend`
3. **Environment**: `Docker` (so it uses `backend/Dockerfile` and gets ffmpeg)
4. **Instance Type**: `Free` is fine — see the free-tier notes below for what
   that trades off, and don't attach a Disk (the free plan doesn't support
   persistent disks; the app now cleans up its own ephemeral storage
   instead — see "Storage on the free plan").
5. Add environment variables (same list as in `render.yaml`): `NODE_ENV=production`,
   `PORT=5000`, `STORAGE_DIR=./storage`, `STORAGE_MAX_AGE_MINUTES=60`,
   `STORAGE_SWEEP_INTERVAL_MINUTES=15`, `MONGO_URI`, `GROQ_API_KEY`,
   `GROQ_WHISPER_MODEL=whisper-large-v3`, `GROQ_ANALYSIS_MODEL=openai/gpt-oss-120b`,
   `CLIENT_ORIGIN`, `MONGO_MAX_POOL_SIZE=5`, `MONGO_MIN_POOL_SIZE=1`,
   `MONGO_MAX_RETRIES=8`, `MONGO_RETRY_DELAY_MS=5000`, `MIN_CLIP_SECONDS=15`,
   `MAX_CLIP_SECONDS=90`, `MIN_CLIPS_PER_JOB=8`, `MAX_CLIPS_PER_JOB=15`,
   `MAX_CONCURRENT_JOBS=1`, `CLIP_RENDER_CONCURRENCY=1`,
   `MAX_UPLOAD_FILE_SIZE=524288000`, `YTDLP_CONCURRENT_FRAGMENTS=4`.
6. Deploy. Once live, note the URL Render gives you, e.g.
   `https://reel-generator-backend.onrender.com`.
7. Sanity check: visit `https://<your-backend>.onrender.com/api/health` — it
   should return `{"ok":true}`.

### Storage on the free plan

Render's free web services get **no persistent disk** — only paid plans
support attaching one. `render.yaml` no longer requests one, so don't add
one manually either. In exchange, the app now clears its own storage
aggressively instead of relying on disk space sticking around:

- The moment a job finishes (whether it **succeeds or fails**), its source
  video (the download or upload) is deleted immediately —
  `workers/jobProcessor.js` now does this on both paths; previously a
  failed job left its video on disk forever.
- A periodic sweep (`STORAGE_MAX_AGE_MINUTES`, default 60) deletes any file
  under `storage/downloads`, `storage/clips`, or `storage/uploads` older
  than that, as a backstop for anything the per-job cleanup misses (a
  crash mid-job, an abandoned chunked upload, a clip you never downloaded).
  It runs on startup and every `STORAGE_SWEEP_INTERVAL_MINUTES` (default
  15) after that — see `server.js`.

**Practical effect:** download clips you want to keep within about an hour
of a job completing, and expect `storage/` to be empty again after every
deploy or after a free-tier idle spin-down/restart cycle — that's expected,
not a bug.

## Step 4 — Deploy the frontend to Vercel

1. In Vercel, **Add New → Project**, import the same GitHub repo.
2. **Root Directory**: `frontend`
3. Framework preset: Vite (auto-detected). Build command `npm run build`,
   output directory `dist` (auto-detected from `vercel.json`/Vite defaults).
4. **Environment Variables**: add
   `VITE_API_URL = https://<your-backend>.onrender.com/api`
   (the `/api` suffix matters — it matches the backend's route prefix).
5. Deploy. Vercel gives you a URL like `https://reel-generator.vercel.app`.

## Step 5 — Connect them: update CORS on the backend

Go back to Render → your backend service → Environment, and set:

```
CLIENT_ORIGIN=https://reel-generator.vercel.app
```

(Comma-separate multiple values if you also want to allow a custom domain or
`localhost:5173` for local testing against the prod backend, e.g.
`https://reel-generator.vercel.app,http://localhost:5173`. To allow Vercel
preview URLs too, add `https://*.vercel.app`.)

Save — Render will redeploy automatically. This is required: without it, the
browser will block API calls from your Vercel domain with a CORS error.

## Step 6 — Verify end-to-end

1. Open your Vercel URL, submit a short test video you own (via upload or
   YouTube URL you control), check the ownership box.
2. Watch the job status page poll through `downloading → transcribing →
   analyzing → clipping → completed`.
3. Download a finished clip to confirm ffmpeg rendering worked on Render.

### Important: storage is ephemeral (by design, on the free plan)

`backend/storage/` (downloads + rendered clips) lives on local disk, and on
the free plan there's no persistent Disk to attach — see "Storage on the
free plan" above for how the app now manages that itself. This setup also
doesn't scale past a single backend instance (a disk-less free instance
included) — for real multi-instance traffic, move `downloader.js`/
`clipper.js` output to S3 (or similar) as the project's README already
flags under "Notes / next steps."

### Cold starts / long jobs on Render

- Jobs run in-process and fire-and-forget from the route handler
  (`processJob` in `workers/jobProcessor.js`) — there's no queue. A Render
  restart or deploy mid-job will drop that job silently (it stays stuck in
  its last `status`). Fine for a demo/personal tool; swap in BullMQ + Redis
  before treating this as production-grade for multiple concurrent users.
- The free tier spins the service down after 15 minutes of inactivity and
  takes roughly 30–60s to wake back up on the next request — expect the
  first request after idle to be slow, and if a job happens to be
  mid-render when the instance sleeps, it can stall or get dropped as
  above. Paid plans avoid this by staying always-on.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Frontend shows network errors calling the API | `VITE_API_URL` missing/wrong on Vercel, or `CLIENT_ORIGIN` on Render doesn't exactly match your Vercel URL (no trailing slash) |
| Jobs fail with “Sign in to confirm you’re not a bot” | YouTube blocked Render’s server IP. For videos you own, upload the source file (most reliable), or securely mount a Netscape-format `cookies.txt` file and set `YTDLP_COOKIES_FILE` to its absolute path. Never commit cookies to the repository. |
| Jobs stuck at `downloading` | `youtube-dl-exec`/YouTube blocking the Render IP, or the source URL isn't actually downloadable — check Render logs |
| ffmpeg errors in logs | You deployed without Docker environment (native Render Node runtime has no ffmpeg) — confirm the service's Environment is set to Docker |
| Clips disappear after a while | Expected on the free plan — either the `STORAGE_MAX_AGE_MINUTES` sweep purged them, or the app was redeployed/idled out. Download clips promptly; see "Storage on the free plan" above |
| 500 on `/api/jobs/...` mentioning Mongo | `MONGO_URI` wrong, or Atlas Network Access doesn't allow Render's IP |