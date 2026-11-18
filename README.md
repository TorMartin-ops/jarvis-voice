# jarvis-voice

A local voice assistant for Windows. You talk to it through the PC microphone and it answers through the speakers. The brain is an Azure OpenAI chat model. It works with Claude Code's own tools (Bash, Read, Edit, Grep, web search) over MCP, so it can act on this PC.

No Discord, no messaging app. Everything runs on your machine, and the only network calls are to ElevenLabs (speech) and Azure OpenAI (the brain).

## How a turn works

1. The microphone is captured by ffmpeg (16 kHz mono).
2. Silero VAD finds the start and end of each utterance.
3. ElevenLabs Scribe turns the utterance into text.
4. A wake-word gate decides whether the text is for the assistant. Naming it opens a conversation window.
5. Azure OpenAI streams the answer. Tool calls run through Claude Code over MCP.
6. Each sentence is sent to ElevenLabs TTS as soon as it is complete, and played through ffplay in order.
7. Talking over the reply for `JARVIS_BARGE_IN_MS` cancels it at once: speech stops, the brain is aborted, and replies to the cancelled turn are discarded.

## Setup

Requirements: Windows 10 or 11, Node.js 20 or newer, Claude Code installed and logged in, an ElevenLabs key, an Azure OpenAI deployment with function calling, and FFmpeg (full build, for ffplay).

```powershell
npm install
copy .env.example .env      # then fill in the values
npm run devices             # shows the microphone names; copy one into JARVIS_MIC
npm test                    # unit tests, no network
npm start                   # starts the assistant
```

For the best results, use a headset. Without one, the speakers can be heard by the microphone, and the assistant may interrupt itself.

`npm run e2e -- "Jarvis, hva klokka er?"` runs one real request through the whole chain (it speaks a phrase with ElevenLabs and checks the answer). It uses API credits.

## Safety

- Tools reached over MCP run with Claude Code's permissions on this PC. The allowlist (`JARVIS_TOOL_ALLOW`) decides which tools exist.
- `src/policy.ts` blocks commands that push to git, delete recursively, send mail, post over HTTP, change the registry or users, shut down, or publish packages. A blocked command returns a message the assistant must relay, so you can run it yourself.
- Write and Edit only work inside `JARVIS_WORKER_CWD`. Paths with `..` are rejected.
- Every tool call and result is written to `~/.jarvis/audit.log`, with secrets redacted.
- Keys live only in `.env`, which is gitignored.

## Limits

- It has not been tested in a shared room or with a headset yet. Echo and background speech are the main risks.
- Latency depends on the tools. A recursive search can take 20 seconds. Keep requests specific.
- Only the brain in the Azure deployment is supported. There is no fallback model.

## Tests

`npm test` runs unit tests for sentence splitting, markdown stripping, the wake-word gate, the safety policy, redaction, SSE parsing, and config loading.

## License

Apache-2.0. See `LICENSE`.
