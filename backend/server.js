import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { connectDB, disconnectDB } from "./src/config/db.js";
import jobsRouter from "./src/routes/jobs.js";

const app = express();

const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
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
  res.status(500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  const server = app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));

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
