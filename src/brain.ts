import type { McpTool } from "./mcp.js";

/**
 * The voice brain: Azure OpenAI chat completions, streamed. With MCP tools it
 * works directly with Claude Code's tools on this PC. Each step is one streamed
 * model call; tool calls run to completion before the next step.
 */

export const SYSTEM_PROMPT = `Du er Jarvis, en stemmeassistent for Tor Martin. Du snakker norsk bokmål.

Svar kort og naturlig, slik et menneske snakker: én til to korte setninger. Ingen lister, markdown, kodeblokker eller emojier, for alt du skriver blir lest opp. Vær direkte, varm og rolig. Ingen flørting.

Du har verktøy som kjører på Claude Code på PC-en (Bash, Read, Edit, Write, Grep, WebSearch m.fl.). Bruk dem når oppgaven krever det. Si kort hva du gjør før et verktøykall, og oppsummer resultatet i tale når du er ferdig.

Hold verktøykallene raske: avgrens søk (hopp over node_modules, .git og dist), og si kort i tale hvis en operasjon tar lang tid.

Før du sender meldinger, sletter, betaler eller endrer tilganger, spør Tor Martin først og vent på et tydelig ja. Hvis et verktøy svarer BLOCKED, si det til ham og foreslå at han kjører det selv.

Når han ber deg være stille, svar bare med ett kort ord eller ingenting.`;

export const MAX_STEPS = 8;
const MAX_HISTORY = 24;
const MAX_TOKENS = 400;

/** One streamed event for the caller. */
export interface BrainHooks {
  onText(chunk: string): void;
  onToolStart?(name: string): void;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

/** Parse one SSE line. Returns the JSON payload, or null for non-data lines and [DONE]. */
export function parseSseLine(line: string): any | null {
  const t = line.trim();
  if (!t.startsWith("data:")) return null;
  const body = t.slice(5).trim();
  if (!body || body === "[DONE]") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export interface BrainOptions {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
  tools: () => McpTool[];
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export class Brain {
  private history: ChatMessage[] = [];
  private readonly url: string;

  constructor(private readonly opts: BrainOptions) {
    const base = opts.endpoint.endsWith("/") ? opts.endpoint : opts.endpoint + "/";
    this.url = `${base}openai/deployments/${encodeURIComponent(opts.deployment)}/chat/completions?api-version=${opts.apiVersion}`;
  }

  /** Add context that is not something Tor Martin said. */
  note(text: string): void {
    this.history.push({ role: "user", content: `[System] ${text}` });
    this.trim();
  }

  /** Answer one user utterance, streaming text to `hooks.onText`. Throws on abort or API failure. */
  async respond(userText: string, hooks: BrainHooks, signal?: AbortSignal): Promise<void> {
    this.history.push({ role: "user", content: userText });
    const specs = this.toolSpecs();
    const system = specs.length ? SYSTEM_PROMPT : SYSTEM_PROMPT.replace(/\n\nDu har verktøy[\s\S]*?oppsummer resultatet i tale når du er ferdig\./, "");

    for (let step = 0; step < MAX_STEPS; step++) {
      const { text, toolCalls, finish } = await this.streamStep(system, specs, hooks, signal);
      if (finish !== "tool_calls" || toolCalls.length === 0) {
        this.history.push({ role: "assistant", content: text });
        this.trim();
        return;
      }
      this.history.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
      for (const c of toolCalls) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        hooks.onToolStart?.(c.name);
        const content = await this.runOne(c);
        this.history.push({ role: "tool", tool_call_id: c.id, content });
      }
    }
    const note = "Jeg rakk ikke å bli ferdig. Vil du at jeg fortsetter?";
    hooks.onText(note);
    this.history.push({ role: "assistant", content: note });
    this.trim();
  }

  private toolSpecs() {
    return this.opts.tools().map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  private async streamStep(system: string, tools: ReturnType<Brain["toolSpecs"]>, hooks: BrainHooks, signal?: AbortSignal) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "api-key": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: system }, ...this.history],
        ...(tools.length ? { tools } : {}),
        stream: true,
        max_completion_tokens: MAX_TOKENS,
        // Voice needs the first word fast. Function tools need reasoning off on chat completions for this model.
        reasoning_effort: "none",
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Azure OpenAI ${res.status}: ${detail}`);
    }

    const calls = new Map<number, ToolCallAcc>();
    let text = "";
    let finish: string | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const choice = parseSseLine(line)?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (delta.content) {
          text += delta.content;
          hooks.onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const acc = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          calls.set(tc.index, acc);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
    return { text, finish, toolCalls: [...calls.values()].filter((c) => c.name) };
  }

  private async runOne(c: ToolCallAcc): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(c.arguments || "{}");
    } catch {
      return "ERROR: tool arguments were not valid JSON.";
    }
    try {
      return await this.opts.runTool(c.name, args);
    } catch (err) {
      return `ERROR: ${(err as Error).message}`;
    }
  }

  /** Keep history short. Cut only at a user message so tool messages are never orphaned. */
  private trim(): void {
    while (this.history.length > MAX_HISTORY) {
      const next = this.history.findIndex((m, i) => i > 0 && m.role === "user");
      if (next < 0) break;
      this.history = this.history.slice(next);
    }
  }
}
