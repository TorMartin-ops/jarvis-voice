# jarvis-voice

A Discord voice assistant. A fast voice model (Claude Haiku, via the Messages API) talks with you in a voice channel. Real work (code, files, research) is handed to background workers, which are Claude Code sessions on the same PC. Results are reported back by voice.

Speech-to-text and text-to-speech use ElevenLabs. Discord audio uses discord.js and @discordjs/voice.

## How it works

1. You speak in the joined voice channel. Voice activity detection finds the end of your sentence.
2. ElevenLabs Scribe turns the speech into text.
3. Haiku answers in one or two short sentences, streamed to ElevenLabs TTS sentence by sentence.
4. For a task, Haiku calls `delegate_task`. A worker runs `claude -p` in the background and writes its report to `~/.jarvis/reports/`. When it finishes, Haiku reports the summary by voice.
5. Speaking over the bot cuts its reply off, and replies to the old turn are dropped.

## Setup

Requirements: Node.js 20+, a Discord bot in a server with voice enabled, an ElevenLabs key, and Claude Code installed and logged in on the PC. An Anthropic API key is optional: with it the brain streams from the API (faster); without it each turn runs Claude Code on the PC.

```bash
npm install
cp .env.example .env   # then fill in the values
npm test
npm start
```

Discord bot permissions: View Channel, Connect, Speak, and the Server Members and Voice State intents. Add `Move Members` only if you want the bot to move people.

## Security

- Keep `.env` out of git. It is listed in `.gitignore`.
- Workers run in `auto` permission mode. The worker prompt forbids sending messages, paying, or deleting unless a task names it explicitly. Review the reports in `~/.jarvis/reports/`.
- Only users in `VOICE_ALLOWED_USERS` are heard.

## Tuning

Defaults are in `.env.example`. Latency is logged to `latency.log` when `VOICE_DEBUG=1` or higher.

## License

Apache-2.0. See `LICENSE`.
