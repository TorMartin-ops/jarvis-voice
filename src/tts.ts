const TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

export interface TtsOptions {
  apiKey: string;
  voice: string;
  model: string;
  signal?: AbortSignal;
}

/**
 * Stream one sentence from ElevenLabs as raw PCM (24 kHz, mono, s16le).
 * Yields chunks as they arrive, so playback can start before the sentence is finished.
 *
 * No language_code is sent: eleven_v4_turbo rejects it for Norwegian (400 unsupported_language),
 * and the model reads Norwegian text correctly without it.
 */
export async function* synthesize(text: string, opts: TtsOptions): AsyncGenerator<Buffer> {
  const url = `${TTS_URL}/${encodeURIComponent(opts.voice)}/stream?output_format=pcm_24000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey, "content-type": "application/json", accept: "audio/pcm" },
    body: JSON.stringify({ text, model_id: opts.model }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`ElevenLabs TTS ${res.status}: ${detail}`);
  }
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    if (value && value.length) yield Buffer.from(value);
  }
}
