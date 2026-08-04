import mongoose from "mongoose";

mongoose.set("strictQuery", true);

const MAX_RETRIES = Number(process.env.MONGO_MAX_RETRIES || 5);
const RETRY_DELAY_MS = Number(process.env.MONGO_RETRY_DELAY_MS || 5000);

mongoose.connection.on("connected", () => console.log("[db] connected"));
mongoose.connection.on("error", (err) => console.error("[db] connection error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("[db] disconnected"));
mongoose.connection.on("reconnected", () => console.log("[db] reconnected"));

export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[db] MONGO_URI is not set");
    process.exit(1);
  }

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      await mongoose.connect(uri, {
        maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
        minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 1),
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        // Keep index builds off the hot path in production; run
        // `Model.syncIndexes()` as a deploy step instead if you add indexes.
        autoIndex: process.env.NODE_ENV !== "production",
      });
      return;
    } catch (err) {
      attempt += 1;
      console.error(`[db] connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt >= MAX_RETRIES) {
        console.error("[db] exhausted retries, exiting");
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

export async function disconnectDB() {
  await mongoose.connection.close();
  console.log("[db] connection closed");
}
