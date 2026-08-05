# Render deploys this with "Environment: Docker". It installs ffmpeg and
# python3 (both required at runtime by fluent-ffmpeg / youtube-dl-exec),
# which are NOT present in Render's native Node runtime.

FROM node:20-bookworm-slim

# ffmpeg: required by src/services/clipper.js (fluent-ffmpeg shells out to it)
# python3: required by the yt-dlp binary that youtube-dl-exec installs
# ca-certificates: needed for HTTPS downloads (YouTube, Groq API)
# (clipper.js does not burn any text into clips, so no font package is
# required here.)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Now copy the rest of the source
COPY . .

# Storage dir for downloads/clips — mount a Render Disk here in production
# (see DEPLOYMENT.md) or clips/uploads will be lost on every redeploy/restart.
RUN mkdir -p storage

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "server.js"]