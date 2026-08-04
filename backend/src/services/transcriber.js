import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3";

/**
 * Transcribes a video/audio file using Groq's hosted Whisper and returns
 * timestamped segments.
 * Returns: [{ start, end, text }, ...]
 */
export async function transcribeVideo(filePath) {
  const audioPath = path.join(path.dirname(filePath), `${uuid()}-speech.mp3`);
  await extractSpeechAudio(filePath, audioPath);

  let response;
  try {
    // A 16 kHz mono 32 kbps MP3 is vastly smaller than the source video while
    // preserving speech quality for transcription.
    response = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: WHISPER_MODEL,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });
  } finally {
    fs.unlinkSync(audioPath, { force: true });
  }

  const segments = (response.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  return segments;
}

function extractSpeechAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("libmp3lame")
      .audioBitrate("32k")
      .format("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(audioPath);
  });
}
