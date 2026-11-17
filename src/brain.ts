import Anthropic from "@anthropic-ai/sdk";

/** The voice front end. Haiku talks; real work is handed to a worker through `delegate_task`. */
export const BRAIN_MODEL = process.env.JARVIS_MODEL?.trim() || "claude-haiku-5-5";
const MAX_HISTORY_MESSAGES = 24;

export const SYSTEM_PROMPT = `Du er Jarvis, en stemmeassistent for Tor Martin. Du snakker norsk bokmål.

Svar kort og naturlig, slik et menneske snakker: én til to korte setninger, uten lister, markdown eller emojier. Vær direkte, varm og rolig. Ingen flørting.

Du gjør ikke tunge oppgaver selv. Kode, filer, git, research, e-post, kalender og alt som tar mer enn ett steg går til en arbeidsagent via verktøyet delegate_task. Skriv en kort, selvstendig beskrivelse av oppgaven. Si kort at du setter i gang, og fortsett samtalen mens den kjører.

Når du får en melding som starter med [Oppgave ferdig], oppsummer resultatet i én eller to setninger og spør om det er mer han trenger.

Når han ber deg være stille, svar bare med ett kort ord eller ingenting.`;

export const DELEGATE_TOOL: Anthropic.Tool = {
  name: "delegate_task",
  description:
    "Start a background worker (Claude Code on the PC) for a task that needs tools or more than one step. Returns immediately; the result is reported back later.",
  input_schema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Self-contained task description in Norwegian or English, with goal, context and what done means.",
      },
    },
    required: ["description"],
  },
};

export interface BrainHooks {
  /** Streamed text for speech. */
  onText(chunk: string): void;
  /** Start a worker; return a short status string for the model. */
  onDelegate(description: string): string;
}

export class Brain {
  private readonly client: Anthropic;
  private history: Anthropic.MessageParam[] = [];

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /** Add a message without generating (for example a finished task report). */
  note(text: string): void {
    this.push({ role: "user", content: text });
  }

  /** `userText` null means a report turn: the model answers from notes already added with `note()`. */
  async respond(userText: string | null, hooks: BrainHooks, signal?: AbortSignal): Promise<void> {
    if (userText) this.push({ role: "user", content: userText });
    // At most two rounds: one for a possible tool call, one for the spoken follow-up.
    for (let round = 0; round < 2; round++) {
      const stream = this.client.messages.stream(
        {
          model: BRAIN_MODEL as Anthropic.Model,
          max_tokens: 300,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [DELEGATE_TOOL],
          messages: this.history,
        },
        { signal },
      );
      stream.on("text", (chunk) => hooks.onText(chunk));
      const message = await stream.finalMessage();
      this.history.push({ role: "assistant", content: message.content });

      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results: Anthropic.ToolResultBlockParam[] = toolUses.map((t) => {
        const description = String((t.input as { description?: unknown })?.description ?? "").trim();
        if (!description) return { type: "tool_result", tool_use_id: t.id, content: "Missing description.", is_error: true };
        return { type: "tool_result", tool_use_id: t.id, content: hooks.onDelegate(description) };
      });
      this.push({ role: "user", content: results });
    }
    this.trim();
  }

  private push(message: Anthropic.MessageParam): void {
    this.history.push(message);
  }

  /** Keep the history short. Cut only at a plain user text message so tool results are never orphaned. */
  private trim(): void {
    while (this.history.length > MAX_HISTORY_MESSAGES) {
      const next = this.history.findIndex((m, i) => i > 0 && m.role === "user" && typeof m.content === "string");
      if (next < 0) break;
      this.history = this.history.slice(next);
    }
  }
}
