import { SYSTEM_PROMPT, DELEGATE_TOOL, type BrainHooks } from "./brain.js";
import type { ClaudeMcp, McpToolDef } from "./claude-mcp.js";

/**
 * Voice brain on Azure OpenAI (chat completions, streamed). With a ClaudeMcp
 * connection the model works directly with Claude Code's tools (Bash, Read, Edit, ...).
 * Without one it falls back to the delegate_task worker tool.
 */
const MAX_HISTORY = 24;
const MAX_STEPS = 8;

const MCP_ADDENDUM = `

Du har verktøy som kjører på Claude Code på PC-en (bl.a. Bash, Read, Edit, Write, Grep, WebSearch). Bruk dem når oppgaven krever det, og svar så kort i tale når du er ferdig.
Før du sender meldinger, sletter, betaler eller endrer tilganger, spør Tor Martin først og vent på et tydelig ja.`;

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

export class AzureBrain {
  private history: ChatMessage[] = [];
  private readonly url: string;

  constructor(
    endpoint: string,
    private readonly apiKey: string,
    deployment: string,
    apiVersion = "2024-10-21",
    private readonly mcp?: ClaudeMcp,
  ) {
    const base = endpoint.endsWith("/") ? endpoint : endpoint + "/";
    this.url = `${base}openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${apiVersion}`;
  }

  note(text: string): void {
    this.history.push({ role: "user", content: `[System] ${text}` });
    this.trim();
  }

  private toolSpecs(): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] {
    const fromMcp = (this.mcp?.getTools() ?? []).map((t: McpToolDef) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (fromMcp.length) return fromMcp;
    return [{ type: "function", function: { name: DELEGATE_TOOL.name, description: DELEGATE_TOOL.description ?? "", parameters: DELEGATE_TOOL.input_schema } }];
  }

  private systemPrompt(): string {
    return this.mcp ? SYSTEM_PROMPT + MCP_ADDENDUM : SYSTEM_PROMPT;
  }

  async respond(userText: string | null, hooks: BrainHooks, signal?: AbortSignal): Promise<void> {
    if (userText) this.history.push({ role: "user", content: userText });
    const tools = this.toolSpecs();

    for (let step = 0; step < MAX_STEPS; step++) {
      const calls = new Map<number, ToolCallAcc>();
      let text = "";
      let finish: string | null = null;

      const res = await fetch(this.url, {
        method: "POST",
        headers: { "api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "system", content: this.systemPrompt() }, ...this.history],
          tools,
          stream: true,
          max_completion_tokens: 400,
          // Voice needs the first word fast. Function tools need reasoning off on chat completions for this model.
          reasoning_effort: "none",
        }),
        signal,
      });
      if (!res.ok || !res.body) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`Azure OpenAI ${res.status}: ${detail}`);
      }

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
          const json = parseSseLine(line);
          const choice = json?.choices?.[0];
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

      const toolCalls = [...calls.values()].filter((c) => c.name);
      if (finish !== "tool_calls" || toolCalls.length === 0) {
        this.history.push({ role: "assistant", content: text });
        this.trim();
        return;
      }

      this.history.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
      });
      for (const c of toolCalls) {
        const content = await this.runTool(c, hooks, signal);
        this.history.push({ role: "tool", tool_call_id: c.id, content });
      }
    }
    // Step limit reached: say so instead of going silent.
    hooks.onText("Jeg rakk ikke å bli ferdig. Vil du at jeg fortsetter?");
    this.history.push({ role: "assistant", content: "Jeg rakk ikke å bli ferdig." });
    this.trim();
  }

  private async runTool(c: ToolCallAcc, hooks: BrainHooks, signal?: AbortSignal): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.arguments || "{}");
    } catch {
      return "ERROR: tool arguments were not valid JSON.";
    }
    if (this.mcp) {
      try {
        if (signal?.aborted) return "ERROR: cancelled.";
        return await this.mcp.call(c.name, args);
      } catch (err) {
        return `ERROR: ${(err as Error).message}`;
      }
    }
    const description = String(args.description ?? "").trim();
    return description ? hooks.onDelegate(description) : "Missing description.";
  }

  /** Keep the history short, cutting only at a plain user message so tool messages are never orphaned. */
  private trim(): void {
    while (this.history.length > MAX_HISTORY) {
      const next = this.history.findIndex((m, i) => i > 0 && m.role === "user");
      if (next < 0) break;
      this.history = this.history.slice(next);
    }
  }
}
