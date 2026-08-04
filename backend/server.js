import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { connectDB, disconnectDB } from "./src/config/db.js";
import jobsRouter from "./src/routes/jobs.js";

const app = express();

const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173").split(",")
  // Browser Origin headers never end with a slash. Normalize values copied
  // from URLs in hosting dashboards so a trailing slash cannot break CORS.
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function isAllowedOrigin(origin) {
  return allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === origin) return true;
    if (!allowedOrigin.includes("*")) return false;

    // An explicitly configured wildcard, e.g. https://*.vercel.app, allows
    // preview URLs while remaining restricted to one hostname label.
    const pattern = `^${allowedOrigin
      .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
      .replace("*", "[^.]+")}$`;
    return new RegExp(pattern).test(origin);
  });
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests (curl, server-to-server health checks) that
      // send no Origin header at all.
      if (!origin || isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin ${origin} is not in CLIENT_ORIGIN`));
    },
  })
);
app.use(express.json());
app.use(morgan("dev"));

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api/jobs", jobsRouter);

app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  if (err.name === "CastError") {
    return res.status(400).json({ error: "Invalid identifier provided." });
  }

  if (err.name === "SyntaxError" && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Malformed request body." });
  }

  if (err.name === "MongooseServerSelectionError" || err.name === "MongoNetworkError" || err.name === "MongooseNetworkError") {
    return res.status(503).json({
      error: "Database unavailable. Please try again in a moment.",
    });
  }

  if (err.code?.startsWith("LIMIT_")) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Video file is too large. Maximum upload size is 1GB."
      : err.message || "Upload limit exceeded.";
    return res.status(413).json({ error: message });
  }

  if (err.message?.includes("unexpected field")) {
    return res.status(400).json({ error: "Invalid upload field." });
  }

  res.status(500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  const server = app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));

  // Node defaults to a five-minute request timeout. A large video on a slower
  // connection can exceed that before multer has finished receiving it, which
  // appears in the browser as a generic network error. Keep an explicit,
  // bounded limit for multipart uploads instead.
  server.requestTimeout = 60 * 60 * 1000;
  server.headersTimeout = 5 * 60 * 1000;
  server.keepAliveTimeout = 65 * 1000;

  async function shutdown(signal) {
    console.log(`[server] received ${signal}, shutting down gracefully`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    // Force-exit if shutdown hangs (e.g. an in-flight job holding a handle).
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
});