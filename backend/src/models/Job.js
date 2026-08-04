import mongoose from "mongoose";

const jobSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      enum: ["youtube_url", "upload"],
      required: true,
    },
    sourceUrl: { type: String }, // present if sourceType === 'youtube_url'
    sourceFilePath: { type: String }, // present if sourceType === 'upload'
    originalFileName: { type: String },

    // The local file path currently backing this job (downloaded video or
    // uploaded file). Cleared once the source video is deleted after all
    // clips are rendered — see workers/jobProcessor.js.
    workingFilePath: { type: String },
    sourceFileRemoved: { type: Boolean, default: false },
    sourceFileRemovedAt: { type: Date },

    // Ownership / rights confirmation — required before processing starts.
    // The UI will not submit a job without this being explicitly checked.
    ownershipConfirmed: { type: Boolean, required: true, default: false },

    ownerCreditName: { type: String, required: true }, // name/channel to credit on generated clips

    status: {
      type: String,
      enum: [
        "queued",
        "downloading",
        "transcribing",
        "analyzing",
        "clipping",
        "completed",
        "failed",
      ],
      default: "queued",
    },
    progress: { type: Number, default: 0 }, // 0-100
    clipRenderCount: { type: Number, default: 0 },
    error: { type: String },

    videoDurationSeconds: { type: Number },
    transcript: [
      {
        start: Number,
        end: Number,
        text: String,
      },
    ],
  },
  { timestamps: true }
);

jobSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("Job", jobSchema);
