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
    // uploaded file). Historically this was cleared the moment a job
    // finished; it's now kept around for a short retention window after
    // completion (see SOURCE_RETENTION_MS in workers/jobProcessor.js) so a
    // "reanalyze" request can reuse it instead of re-downloading/re-uploading
    // the same video. Still cleared eventually — either by the scheduled
    // cleanup once the window lapses, or immediately on failure.
    workingFilePath: { type: String },
    sourceFileRemoved: { type: Boolean, default: false },
    sourceFileRemovedAt: { type: Date },
    // When the shared source file behind this job (see sourceGroupId below)
    // is scheduled to be deleted. Purely informational for the frontend
    // (e.g. "reanalyze before Xm" countdown) — the actual deletion is driven
    // by the in-memory timer in jobProcessor.js, not by reading this field.
    sourceRetentionExpiresAt: { type: Date },

    // Every job that shares one physical source video (the original job plus
    // any "reanalyze" jobs run against it) shares one sourceGroupId, so they
    // can find each other: to reuse the still-on-disk file/transcript, to
    // avoid re-selecting moments an earlier job in the group already used,
    // and to coordinate the shared file's retention timer. Left unset on the
    // original job (its own _id is used as the group key); set on every
    // reanalysis job spawned from it.
    sourceGroupId: { type: mongoose.Schema.Types.ObjectId, ref: "Job" },
    // The specific job this one was reanalyzed from (its immediate parent,
    // not necessarily the root of the group).
    reanalyzedFrom: { type: mongoose.Schema.Types.ObjectId, ref: "Job" },
    isReanalysis: { type: Boolean, default: false },
    // Time ranges (seconds into the video) already used by an earlier clip
    // in this job's group — passed to analyzeBestMoments so a reanalysis
    // surfaces different moments instead of re-picking the same ones.
    excludeRanges: [
      {
        start: Number,
        end: Number,
      },
    ],

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
    // Set once processing actually begins (see workers/jobProcessor.js) and
    // used by the frontend to show "Started Xs/Xm/Xh ago". This was missing
    // from the schema, so Mongoose silently dropped the field on save and
    // it never reached the client.
    startedAt: { type: Date },
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
