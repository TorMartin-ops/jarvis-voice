# jarvis-voice

A local voice assistant for Windows. You talk through the PC microphone and it answers through the speakers. No Discord, no messaging app.

- **Luna talks.** An Azure OpenAI chat model (for example `gpt-6-luna`) handles the conversation only. It answers in one or two short sentences, streamed sentence by sentence to speech.
- **Claude Code works.** Anything that needs files, code, the web, email or more than a quick answer becomes a task. Each task runs in its own headless Claude Code session in the background. When it finishes, Luna tells you the result.

## How a turn works

1. ffmpeg captures the microphone (16 kHz mono).
2. Silero VAD finds where each utterance starts and ends (600 ms of silence by default).
3. ElevenLabs Scribe turns the utterance into text. Fragments and a bare wake word wait briefly for the rest of the request.
4. A wake-word gate decides whether the text is for the assistant. Saying "Jarvis" or "Luna" opens a conversation window.
5. Luna streams the answer. It can start, list and cancel tasks, and remember or forget facts.
6. Each finished sentence goes to ElevenLabs TTS at once and plays through ffplay in order. The next sentence is synthesized while the current one plays.
7. Talking over the reply for `JARVIS_BARGE_IN_MS` cancels it at once. Luna is told that the rest was not heard.

Measured on this setup: Luna's first token about 0.5 s, end of speech to first audio about 1.0 s for a plain answer.

## Tasks

- Workers run `claude -p` in `auto` permission mode with a deny list (git push, recursive delete, sending mail, registry and user changes, shutdown, npm publish).
- Outward or irreversible actions are allowed only when you confirmed them out loud. Luna reads back exactly what will happen, waits for "ja, send" or "ja, gjør det", and passes the confirmed action to the worker. Workers refuse anything else and report what they would have done.
- Workers treat text from web pages, email and files as data, not instructions.
- Tasks are saved in `~/.jarvis/tasks.json` with progress, deadline (30 min default) and final status. A task left running by a crash is marked `lost` on the next start. Full reports go to `~/.jarvis/reports/`.

## Memory

Luna keeps a short list of facts you asked it to remember (`~/.jarvis/memory.json`, at most 40). Say "husk at ..." or "glem ...". Nothing is stored unless you ask.

## Setup

Requirements: Windows 10 or 11, Node.js 20+, Claude Code installed and logged in, an ElevenLabs key, an Azure OpenAI chat deployment with function calling, and FFmpeg 7+ full build (for ffplay).

```powershell
npm install
copy .env.example .env      # then fill in the values
npm run devices             # lists microphones; copy one into JARVIS_MIC
npm test                    # unit tests, no network
npm start
```

Use a headset for now. Without one, the speakers reach the microphone and the assistant can interrupt itself.

`npm run e2e -- "Jarvis, hva er klokka?"` sends one spoken request through the whole chain. Add `--task` to wait for a delegated task and Luna's report. It uses API credits.

## Keys and privacy

Keys live only in `.env`, which is gitignored. Logs redact anything that looks like a key or token. Audio goes to ElevenLabs only while you speak; text goes to Azure OpenAI.

## Roadmap

Ranked by impact, from the research in this project:

1. Echo cancellation (WebRTC AEC3) so barge-in works on speakers.
2. Local wake word (openWakeWord "hey jarvis") so audio is only sent to STT after the wake word.
3. Semantic end-of-turn model (LiveKit turn detector, local) with a 1.5 s silence fallback.
4. Claude Agent SDK workers with `canUseTool`, so a worker can ask for approval by voice mid-task.
5. Tray app started at logon (Task Scheduler), with device hot-plug handling.
6. Speaker verification (WeSpeaker or ECAPA) as a convenience gate.

## License

Apache-2.0. See `LICENSE`.
