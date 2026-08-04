import mongoose from "mongoose";

const clipSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    startSeconds: { type: Number, required: true },
    endSeconds: { type: Number, required: true },
    caption: { type: String, required: true },
    hashtags: [{ type: String }],
    creditLine: { type: String, required: true }, // e.g. "Original video by <owner>"
    rankScore: { type: Number }, // how the analyzer ranked this moment
    filePath: { type: String }, // path to the rendered clip on disk
    status: {
      type: String,
      enum: ["pending", "rendered", "failed"],
      default: "pending",
    },
  },
  { timestamps: true }
);

clipSchema.index({ job: 1 });

export default mongoose.model("Clip", clipSchema);
