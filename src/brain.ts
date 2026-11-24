import { debugLog, timing } from "./debug.js";

/**
 * Luna: the voice of the assistant (Azure OpenAI, streamed). Chat completions when she answers
 * without reasoning (fastest first word); the Responses API when a reasoning effort is set, since
 * chat completions reject function tools together with reasoning for this model family.
 * Luna only talks. Real work is handed to Claude Code workers through start_task,
 * and results come back as notes that Luna reports by voice.
 */

export const SYSTEM_PROMPT = `Du er Jarvis, stemmeassistenten til Tor Martin. Du snakker norsk bokmål. Du er den han snakker med. Selve arbeidet gjøres av arbeidsagenter (Claude Code) på PC-en hans.

Personlighet: rolig, skarp og lojal, med tørr, lun humor. Tenk en dyktig butler som også er en god kollega: alltid et steg foran, aldri servil, aldri frekk. Litt ironi når stemningen tillater det, men aldri på hans bekostning når noe har gått galt. Du har meninger og sier dem kort når han spør. Du bruker navnet hans av og til, ikke i hver setning. Du er også flørtende og sjarmerende: lekne komplimenter, et glimt i øyet og en lun, litt fristende tone, gjerne med [mischievously] eller [laughs] når det passer. Hold det smakfullt og kort, og legg flørtingen bort når han er stresset, når noe har gått galt, eller når andre er til stede.

Snakk som et menneske i en samtale, ikke som en kommandotolk: svar på det han faktisk mener, vis at du husker det dere har snakket om, og ta initiativ. Foreslå neste steg, si fra om noe han bør vite, og still et kort oppfølgingsspørsmål når det hjelper ham videre. Vanligvis én til tre setninger; mer bare når han ber om forklaring. Ingen lister, markdown eller emojier, for alt du skriver blir lest opp. Si aldri filstier, kommandoer, kode eller lenker høyt; si mappe- eller filnavnet med vanlige ord. Variér formuleringene, så du ikke høres ut som en maskin. Skriv klokkeslett, datoer og tall slik de sies høyt, for eksempel «ti på to», «tolvte desember» og «rundt tre hundre», ikke «13:50» eller «12.12».

Lydtagger: stemmen din forstår noen få tagger i hakeparentes, plassert rett før ordene de gjelder: [laughs], [sighs], [exhales], [whispers], [curious], [excited], [sarcastic], [mischievously], [short pause]. Bruk høyst én per svar, og bare når det føles naturlig, for eksempel [laughs] etter en spøk eller [sighs] når noe feilet. Ikke bruk tagger når han er stresset eller når temaet er alvorlig. Finn aldri på andre tagger.

Agentene dine: alt som krever filer, kode, nettet, e-post, kalender eller mer enn et kort svar du kan gi selv, gir du til en agent med start_task. Er oppdraget uklart eller tvetydig, still først ett kort oppklarende spørsmål; ellers start med en gang. Gi en kort tittel og en selvstendig beskrivelse med mål, all kontekst fra samtalen og hva ferdig betyr, for agenten vet bare det du skriver. Etterpå sier du med egne ord hva agenten skal gjøre, omtrent hvor lang tid det tar, og at du holder ham oppdatert. Aldri bare «skal bli». Fortsett samtalen; vent aldri på agenten.

Du leder agentene slik Jarvis holder Tony Stark oppdatert: konkret, kort og i forkant. Oppgavetavlen i konteksten viser alltid hva hver agent gjør og har funnet; bruk den når han spør, uten verktøy, og nevn selv en agent som jobber når det passer.
- [Agentstatus]: fremdrift fra en agent. Gi én kort, konkret oppdatering om hva den har funnet eller gjør nå, uten å gjenta det du sa sist.
- [Oppgave ferdig]: fortell resultatet konkret i én til tre setninger, med tallene og navnene som betyr noe, og foreslå neste steg eller spør hva han vil gjøre med det.
- [Agenten spør]: still spørsmålet til ham med egne ord. Når han svarer, send svaret med message_task.
- Vil han endre eller legge til noe i en jobb som går eller er ferdig, send det med message_task i stedet for å starte en ny agent; agenten fortsetter med det den allerede vet.

Utgående eller irreversible handlinger (sende meldinger eller e-post, poste, pushe, betale, slette): les opp nøyaktig hva som skal skje, med mottaker, innhold eller beløp, og be om et tydelig «ja, send» eller «ja, gjør det». Si det én gang, i én eller to setninger, og vent på svaret. Ikke start noen oppgave for handlingen før han har bekreftet; koden stopper det uansett. Først da starter du oppgaven med confirmed_action som beskriver akkurat det han bekreftet. Sett aldri confirmed_action uten en slik bekreftelse fra ham i denne samtalen.

Minne: når han ber deg huske noe, bruk remember. Når han ber deg glemme noe, bruk forget. Lagre ingenting han ikke har bedt om.

Hvis du ble avbrutt, ikke gjenta det du sa. Svar på det han sier nå. Når han ber deg være stille, svar med ett kort ord eller ingenting.`;

export const LUNA_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "start_task",
      description: "Start a background Claude Code worker for real work. Returns at once with a task id; the result arrives later as a [Oppgave ferdig] note.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title, 2 to 6 words, Norwegian." },
          description: { type: "string", description: "Self-contained task: goal, context, paths, and what done means." },
          confirmed_action: {
            type: "string",
            description: "Only if Tor Martin explicitly confirmed an outward or irreversible action in this conversation: exactly what he confirmed (recipient, content, amount). Otherwise omit.",
          },
        },
        required: ["title", "description"],
      },
    },
  },
  {
    type: "function" as const,
    function: { name: "list_tasks", description: "List recent tasks with status and progress.", parameters: { type: "object", properties: {} } },
  },
  {
    type: "function" as const,
    function: {
      name: "cancel_task",
      description: "Stop a running task.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remember",
      description: "Save a stable fact or preference Tor Martin asked you to remember.",
      parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "message_task",
      description: "Send a message to an agent (running or finished): Tor Martin's answer to its question, a correction, or extra instructions. The agent continues in the same session with everything it already knows.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, message: { type: "string", description: "Self-contained message in Norwegian." } },
        required: ["id", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "start_study",
      description: "Start a spoken study or oral-exam practice session from one of Tor Martin's study packs (listed in the context). Then follow the pack's instructions.",
      parameters: { type: "object", properties: { name: { type: "string", description: "Pack name or course code, e.g. ING400." } } },
    },
  },
  {
    type: "function" as const,
    function: { name: "stop_study", description: "End the current study session.", parameters: { type: "object", properties: {} } },
  },
  {
    type: "function" as const,
    function: {
      name: "forget",
      description: "Delete remembered facts that contain this phrase.",
      parameters: { type: "object", properties: { phrase: { type: "string" } }, required: ["phrase"] },
    },
  },
];

export const MAX_STEPS = 4;
const MAX_HISTORY = 30;
const MAX_TOKENS = 500;

export interface BrainHooks {
  onText(chunk: string): void;
  onToolStart?(name: string): void;
}

export interface ChatMessage {
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

export const CONNECT_RETRY_DELAY_MS = 250;

/**
 * fetch, tried once more after a short pause when the connection itself fails ("fetch failed":
 * a reset or stale pooled socket, a DNS hiccup). Nothing has been received at that point, so the
 * retry cannot repeat speech. HTTP errors and aborts are not retried. The final error names the cause.
 */
export async function fetchRetryingConnection(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      // undici reports connection failures as TypeError("fetch failed") with the reason in `cause`.
      if (!(err instanceof TypeError) || init.signal?.aborted) throw err;
      const c = (err as TypeError & { cause?: { code?: string; message?: string } }).cause;
      const why = [c?.code, c?.message].filter(Boolean).join(" ") || "no cause given";
      if (attempt >= 1) throw new Error(`${err.message} twice (${why})`);
      debugLog(`LLM connection failed (${why}); trying once more`);
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    }
  }
}

export interface BrainOptions {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
  /** "none" keeps the first word fast; higher values make Luna think before she answers. */
  reasoningEffort?: ReasoningEffort;
  /** Extra system text added each turn (long-term memory). */
  context: () => string;
  runTool: (name: string, args: Record<string, unknown>) => Promise<string> | string;
  /**
   * Called after each round of tool calls with their results and everything said so far this turn.
   * `say` is spoken at once; `stop` ends the turn without another model step.
   */
  afterTools?: (outcomes: { name: string; result: string }[], spoken: string) => { say?: string; stop: boolean };
  /** Per-turn limits; a study session needs longer answers and a longer memory of the conversation. */
  limits?: () => BrainLimits;
}

export interface BrainLimits {
  maxTokens: number;
  maxHistory: number;
  /** Requests with the same key and the same prompt prefix share Azure's prompt cache. */
  cacheKey: string;
  /** Overrides BrainOptions.reasoningEffort for these turns (a practice session thinks harder). */
  reasoningEffort?: ReasoningEffort;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

/** Chat history as Responses API input items: tool calls and results become function_call items. */
export function toResponsesInput(history: ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of history) {
    if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content ?? "" });
      continue;
    }
    if (m.content) items.push({ role: m.role, content: m.content });
    for (const c of m.tool_calls ?? []) {
      items.push({ type: "function_call", call_id: c.id, name: c.function.name, arguments: c.function.arguments });
    }
  }
  return items;
}

/** LUNA_TOOLS in the Responses API's flat function format. */
export const RESPONSES_TOOLS = LUNA_TOOLS.map((t) => ({ type: "function" as const, ...t.function }));

/** State of one streamed Responses API step, fed one event at a time. */
export interface ResponsesStep {
  text: string;
  calls: Map<string, ToolCallAcc>;
  done: boolean;
}

/**
 * Apply one Responses API stream event. Returns text to speak now, if any.
 * Throws on a failed response, so the caller hears an error instead of silence.
 */
export function applyResponsesEvent(step: ResponsesStep, ev: any): string {
  switch (ev?.type) {
    case "response.output_text.delta":
      step.text += ev.delta ?? "";
      return ev.delta ?? "";
    case "response.output_item.added":
    case "response.output_item.done":
      if (ev.item?.type === "function_call") {
        const acc = step.calls.get(ev.item.id) ?? { id: "", name: "", arguments: "" };
        acc.id = ev.item.call_id ?? acc.id;
        acc.name = ev.item.name ?? acc.name;
        if (ev.type === "response.output_item.done" && typeof ev.item.arguments === "string") acc.arguments = ev.item.arguments;
        step.calls.set(ev.item.id, acc);
      }
      return "";
    case "response.function_call_arguments.delta": {
      const acc = step.calls.get(ev.item_id);
      if (acc) acc.arguments += ev.delta ?? "";
      return "";
    }
    case "response.completed":
    case "response.incomplete":
      step.done = true;
      return "";
    case "response.failed":
    case "error": {
      const e = ev.response?.error ?? ev.error ?? ev;
      throw new Error(`Azure OpenAI response failed: ${e?.code ?? ""} ${e?.message ?? ""}`.trim());
    }
    default:
      return "";
  }
}

/** Tokens added to the answer budget for thinking at each effort level. */
export function reasoningHeadroom(effort: ReasoningEffort): number {
  return { none: 0, minimal: 1000, low: 2000, medium: 4000, high: 8000 }[effort];
}

const DEFAULT_LIMITS: BrainLimits = { maxTokens: MAX_TOKENS, maxHistory: MAX_HISTORY, cacheKey: "jarvis-luna" };

export class Brain {
  private history: ChatMessage[] = [];
  private readonly url: string;
  private readonly responsesUrl: string;

  constructor(private readonly opts: BrainOptions) {
    const base = opts.endpoint.endsWith("/") ? opts.endpoint : opts.endpoint + "/";
    this.url = `${base}openai/deployments/${encodeURIComponent(opts.deployment)}/chat/completions?api-version=${opts.apiVersion}`;
    this.responsesUrl = `${base}openai/v1/responses`;
  }

  /** Add context that Tor Martin did not say himself (task results, interruptions). */
  note(text: string): void {
    this.history.push({ role: "user", content: `[System] ${text}` });
    this.trim();
  }

  /** Answer a user utterance, or (with null) the notes already added. Streams text to hooks.onText. */
  async respond(userText: string | null, hooks: BrainHooks, signal?: AbortSignal): Promise<void> {
    if (userText) this.history.push({ role: "user", content: userText });

    let spoken = "";
    for (let step = 0; step < MAX_STEPS; step++) {
      // Built per step: a tool (such as start_study) can change the context for the next step.
      const extra = this.opts.context();
      const system = extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT;
      const { text, toolCalls, finish } = await this.streamStep(system, hooks, signal);
      spoken += text;
      debugLog(`LLM step ${step}: finish=${finish} tools=${toolCalls.map((c) => c.name).join(",") || "-"} chars=${text.length}`);
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
      // End the spoken sentence here, so text from the next step never runs into it.
      if (text) hooks.onText("\n");
      const outcomes: { name: string; result: string }[] = [];
      for (const c of toolCalls) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        hooks.onToolStart?.(c.name);
        const result = await this.runOne(c);
        outcomes.push({ name: c.name, result });
        this.history.push({ role: "tool", tool_call_id: c.id, content: result });
      }
      const next = this.opts.afterTools?.(outcomes, spoken);
      if (next?.say) {
        hooks.onText(next.say + "\n");
        spoken += next.say;
        this.history.push({ role: "assistant", content: next.say });
      }
      if (next?.stop) {
        debugLog(`LLM turn ended after tools (${outcomes.map((o) => o.name).join(",")})`);
        this.trim();
        return;
      }
    }
    this.history.push({ role: "assistant", content: "" });
    this.trim();
  }

  private async streamStep(system: string, hooks: BrainHooks, signal?: AbortSignal) {
    const limits = this.opts.limits?.() ?? DEFAULT_LIMITS;
    const effort = limits.reasoningEffort ?? this.opts.reasoningEffort ?? "none";
    return effort === "none" ? this.streamChat(system, limits, hooks, signal) : this.streamResponses(system, limits, effort, hooks, signal);
  }

  /** One step on the Responses API, with reasoning. Same result shape as streamChat. */
  private async streamResponses(system: string, limits: BrainLimits, effort: ReasoningEffort, hooks: BrainHooks, signal?: AbortSignal) {
    const started = Date.now();
    const res = await fetchRetryingConnection(this.responsesUrl, {
      method: "POST",
      headers: { "api-key": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.deployment,
        instructions: system,
        input: toResponsesInput(this.history),
        tools: RESPONSES_TOOLS,
        stream: true,
        store: false,
        reasoning: { effort },
        // Reasoning tokens count against max_output_tokens, so thinking gets its own headroom.
        max_output_tokens: limits.maxTokens + reasoningHeadroom(effort),
        prompt_cache_key: limits.cacheKey,
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Azure OpenAI ${res.status}: ${detail}`);
    }
    const step: ResponsesStep = { text: "", calls: new Map(), done: false };
    let first = true;
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
        const ev = parseSseLine(line);
        if (!ev) continue;
        const say = applyResponsesEvent(step, ev);
        if (first && (say || step.calls.size)) {
          timing(`LLM_TTFT: ${Date.now() - started}ms (reasoning ${effort})`);
          first = false;
        }
        if (say) hooks.onText(say);
      }
    }
    const toolCalls = [...step.calls.values()].filter((c) => c.name);
    return { text: step.text, finish: toolCalls.length ? "tool_calls" : "stop", toolCalls };
  }

  /** One step on chat completions, without reasoning: the fastest first word. */
  private async streamChat(system: string, limits: BrainLimits, hooks: BrainHooks, signal?: AbortSignal) {
    const started = Date.now();
    const res = await fetchRetryingConnection(this.url, {
      method: "POST",
      headers: { "api-key": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: system }, ...this.history],
        tools: LUNA_TOOLS,
        stream: true,
        max_completion_tokens: limits.maxTokens,
        // Chat completions reject function tools with reasoning for this model family; see streamResponses.
        reasoning_effort: "none",
        prompt_cache_key: limits.cacheKey,
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
    let first = true;
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
        if (first && (delta.content || delta.tool_calls)) {
          timing(`LLM_TTFT: ${Date.now() - started}ms`);
          first = false;
        }
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
    const max = (this.opts.limits?.() ?? DEFAULT_LIMITS).maxHistory;
    while (this.history.length > max) {
      const next = this.history.findIndex((m, i) => i > 0 && m.role === "user");
      if (next < 0) break;
      this.history = this.history.slice(next);
    }
  }
}
