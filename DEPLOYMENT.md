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
4. **Instance Type**: at least `Starter` — video processing needs more than
   the free tier's RAM/CPU, and the free tier spins down on idle mid-job.
5. **Add a Disk** (Render dashboard → your service → Disks): mount path
   `/app/storage`, at least 5GB. Without this, every deploy/restart wipes
   downloaded videos and rendered clips — see the note in Step 6.
6. Add environment variables (same list as in `render.yaml`): `NODE_ENV=production`,
   `PORT=5000`, `STORAGE_DIR=./storage`, `MONGO_URI`, `GROQ_API_KEY`,
   `GROQ_WHISPER_MODEL=whisper-large-v3`, `GROQ_ANALYSIS_MODEL=llama-3.3-70b-versatile`,
   `CLIENT_ORIGIN`, `MONGO_MAX_POOL_SIZE=10`, `MONGO_MIN_POOL_SIZE=2`,
   `MONGO_MAX_RETRIES=8`, `MONGO_RETRY_DELAY_MS=5000`, `MIN_CLIP_SECONDS=15`,
   `MAX_CLIP_SECONDS=60`, `MAX_CLIPS_PER_JOB=20`.
7. Deploy. Once live, note the URL Render gives you, e.g.
   `https://reel-generator-backend.onrender.com`.
8. Sanity check: visit `https://<your-backend>.onrender.com/api/health` — it
   should return `{"ok":true}`.

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

### Important: storage is ephemeral without a disk

`backend/storage/` (downloads + rendered clips) lives on local disk. On
Render, **local disk is wiped on every deploy and on some restarts unless
you attach a persistent Disk** (Step 3 covers this). Even with a disk
attached, clips only exist as long as that one instance's disk — this setup
doesn't scale past a single backend instance. For real multi-instance
traffic, move `downloader.js`/`clipper.js` output to S3 (or similar) as the
project's README already flags under "Notes / next steps."

### Cold starts / long jobs on Render

- Jobs run in-process and fire-and-forget from the route handler
  (`processJob` in `workers/jobProcessor.js`) — there's no queue. A Render
  restart or deploy mid-job will drop that job silently (it stays stuck in
  its last `status`). Fine for a demo/personal tool; swap in BullMQ + Redis
  before treating this as production-grade for multiple concurrent users.
- If you're on Render's free tier, the service spins down after 15 minutes
  of inactivity and takes ~30–60s to wake back up on the next request —
  expect the first request after idle to be slow. Paid plans avoid this.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Frontend shows network errors calling the API | `VITE_API_URL` missing/wrong on Vercel, or `CLIENT_ORIGIN` on Render doesn't exactly match your Vercel URL (no trailing slash) |
| Jobs stuck at `downloading` | `youtube-dl-exec`/YouTube blocking the Render IP, or the source URL isn't actually downloadable — check Render logs |
| ffmpeg errors in logs | You deployed without Docker environment (native Render Node runtime has no ffmpeg) — confirm the service's Environment is set to Docker |
| Clips disappear after a while | No persistent Disk attached, or app was redeployed — see the ephemeral storage note above |
| 500 on `/api/jobs/...` mentioning Mongo | `MONGO_URI` wrong, or Atlas Network Access doesn't allow Render's IP |
