# jarvis-voice

A local voice assistant for Windows and macOS. You talk through the computer's microphone and it answers through the speakers or a headset. No Discord, no messaging app.

- **Luna talks.** An Azure OpenAI chat model (for example `gpt-6-luna`) handles the conversation only. It answers in one or two short sentences, streamed sentence by sentence to speech.
- **Claude Code works.** Anything that needs files, code, the web, email or more than a quick answer becomes a task. Each task runs in its own headless Claude Code session in the background. When it finishes, Luna tells you the result.

## Personality

Jarvis is calm, sharp and loyal, with dry, warm humour: a capable butler who is also a good colleague. It greets you at start-up with a remark about the time of day, varies its wording, and knows the real date and time on every turn.

It uses ElevenLabs audio tags sparingly (at most one per reply): `[laughs]`, `[sighs]`, `[exhales]`, `[whispers]`, `[curious]`, `[excited]`, `[sarcastic]`, `[mischievously]`, `[short pause]`. Unknown tags are removed before speech, aliases such as `[giggles]` become `[laughs]`, and a tag sent on its own is moved to the next sentence. `npm run test:tags` checks every allowed tag against the live TTS and STT: each is performed, none is read aloud.

## Listening on speakers or a headset

- `JARVIS_AUDIO_MODE=headset` (default): talking over a reply for 400 ms cuts it off at once.
- `JARVIS_AUDIO_MODE=speakers`: the microphone hears the reply, so a software echo guard compares what it hears with what Jarvis just said and ignores its own voice. Only a real request cuts the reply.
- In both modes, acknowledgements such as "mm", "ja" or "okei" while Jarvis talks are ignored instead of interrupting.

## How a turn works

1. ffmpeg captures the microphone (16 kHz mono): DirectShow on Windows, AVFoundation on macOS.
2. Silero VAD finds where each utterance starts and ends (600 ms of silence by default).
3. ElevenLabs Scribe turns the utterance into text. Fragments and a bare wake word wait briefly for the rest of the request.
4. A wake-word gate decides whether the text is for the assistant. Saying "Jarvis" or "Luna" opens a conversation window.
5. Luna streams the answer. It can start, list and cancel tasks, and remember or forget facts. When a tool needs no answer (a task started, a fact saved), the turn ends without another model call, and a short acknowledgement is spoken at once if Luna had not said anything yet.
6. Each finished sentence goes to ElevenLabs TTS at once and plays through ffplay in order. The next sentence is synthesized while the current one plays.
7. Talking over the reply for `JARVIS_BARGE_IN_MS` cancels it at once. Luna is told that the rest was not heard.

Measured on this setup: Luna's first token about 0.5 s, end of speech to first audio about 1.0 s for a plain answer.

## Tasks

- Workers run `claude -p` in `auto` permission mode with a deny list (git push, recursive delete, sending mail, registry and user changes, shutdown, npm publish, and on macOS also sudo, the keychain and AppleScript).
- Outward or irreversible actions need your spoken confirmation, enforced in code, not only in the prompt. Luna reads back exactly what will happen; a confirmed action is accepted only if the previous reply asked for confirmation and your answer is a short, explicit go-ahead ("ja, send", "ja, gjør det", "kjør på"). The request itself, a bare "ja", or a task report can never confirm. Workers refuse anything else and report what they would have done. (Testing found the model confirming on its own behalf, which is why this check exists.)
- Workers treat text from web pages, email and files as data, not instructions.
- Tasks are saved in `~/.jarvis/tasks.json` with progress, deadline (30 min default) and final status. A task left running by a crash is marked `lost` on the next start. Full reports go to `~/.jarvis/reports/`.

## Memory

Luna keeps a short list of facts you asked it to remember (`~/.jarvis/memory.json`, at most 40). Say "husk at ..." or "glem ...". Nothing is stored unless you ask.

## Setup

Requirements: Node.js 20+, Claude Code installed and logged in, an ElevenLabs key, an Azure OpenAI chat deployment with function calling, and ffplay from FFmpeg 7+ for playback.

### Windows 10 or 11

```powershell
winget install Gyan.FFmpeg   # ffplay
npm install
copy .env.example .env       # then fill in the values
npm run devices              # lists microphones; copy one into JARVIS_MIC
npm test                     # unit tests, no network
npm start
```

### macOS

```bash
brew install node ffmpeg     # ffmpeg includes ffplay
npm install
cp .env.example .env         # then fill in the values
npm run devices              # optional: JARVIS_MIC defaults to the system microphone
npm test
npm start
```

The first start asks for microphone access for your terminal app. If you said no, turn it on in System Settings > Privacy & Security > Microphone and start again. Claude Code is found in `~/.local/bin` or on your PATH; set `CLAUDE_BIN` if it lives elsewhere.

### Both

Use a headset if you can. On a laptop's built-in speakers and microphone, set `JARVIS_AUDIO_MODE=speakers` so the assistant ignores its own voice.

`npm run e2e -- "Jarvis, hva er klokka?"` sends one spoken request through the whole chain. Add `--task` to wait for a delegated task and Luna's report. It uses API credits.

## Tests

- `npm test`: 33 unit tests and 8 conversation tests with fake services (echo guard, backchannels, barge-in, tag carry-over, announcements, the turn policy after tool calls against a fake Azure stream), no network.
- `npm run test:tags`: every audio tag against live ElevenLabs TTS and STT.
- `npm run e2e -- "Jarvis, ... | ja, send" --dry-tasks`: spoken multi-turn test through the whole chain. Flags: `--task`, `--echo` (own audio fed back into the mic), `--greet`, `--dry-tasks`.

GitHub Actions runs `npm test` on macOS and Windows for every push, and checks that the bundled ffmpeg has each platform's microphone driver. Live voice tests have been run on Windows; on macOS the code paths are covered by tests and CI, not yet by a live session.

## Keys and privacy

Keys live only in `.env`, which is gitignored. Logs redact anything that looks like a key or token. Audio goes to ElevenLabs only while you speak; text goes to Azure OpenAI.

## Roadmap

Ranked by impact, from the research in this project:

1. Echo cancellation (WebRTC AEC3) so barge-in works on speakers.
2. Local wake word (openWakeWord "hey jarvis") so audio is only sent to STT after the wake word.
3. Semantic end-of-turn model (LiveKit turn detector, local) with a 1.5 s silence fallback.
4. Claude Agent SDK workers with `canUseTool`, so a worker can ask for approval by voice mid-task.
5. Tray or menu-bar app started at logon (Task Scheduler on Windows, launchd on macOS), with device hot-plug handling.
6. Speaker verification (WeSpeaker or ECAPA) as a convenience gate.

## License

Apache-2.0. See `LICENSE`.
