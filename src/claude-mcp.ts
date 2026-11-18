import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CLAUDE_BIN, WORKER_CWD } from "./worker.js";

/**
 * Connects to Claude Code's own MCP server (`claude mcp serve`) and exposes a
 * allowlisted set of its tools (Bash, Read, Edit, ...) to the voice brain.
 * Every call is written to an audit log.
 */
const DEFAULT_ALLOW = ["Read", "Glob", "Grep", "Bash", "PowerShell", "Edit", "Write", "WebSearch", "WebFetch"];
const CALL_TIMEOUT_MS = Number(process.env.JARVIS_TOOL_TIMEOUT_MS) || 120_000;
const RESULT_CAP = 8000;
const AUDIT_DIR = join(homedir(), ".jarvis");
const AUDIT_FILE = join(AUDIT_DIR, "audit.log");

export interface McpToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ClaudeMcp {
  private client: Client | null = null;
  private tools: McpToolDef[] = [];
  private readonly allow: Set<string>;

  constructor(allow?: string[]) {
    const list = allow ?? (process.env.JARVIS_TOOL_ALLOW ? process.env.JARVIS_TOOL_ALLOW.split(",").map((s) => s.trim()) : DEFAULT_ALLOW);
    this.allow = new Set(list.filter(Boolean));
  }

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: CLAUDE_BIN,
      args: ["mcp", "serve"],
      cwd: WORKER_CWD,
      stderr: "ignore",
    });
    const client = new Client({ name: "jarvis-voice", version: "0.1.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    this.tools = tools
      .filter((t) => this.allow.has(t.name))
      .map((t) => ({
        name: t.name,
        description: (t.description ?? "").slice(0, 1000),
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
    this.client = client;
    audit(`connected; tools: ${this.tools.map((t) => t.name).join(",")}`);
  }

  getTools(): McpToolDef[] {
    return this.tools;
  }

  /** Run one tool and return text for the model, capped in size. */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("Claude Code MCP is not connected");
    if (!this.allow.has(name)) return `Tool ${name} is not allowed.`;
    audit(`call ${name} ${JSON.stringify(args).slice(0, 300)}`);
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    const text = ((result.content as { type: string; text?: string }[]) ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const out = text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) + "\n[cut]" : text;
    audit(`result ${name} ${out.length} chars${result.isError ? " ERROR" : ""}`);
    return result.isError ? `ERROR: ${out}` : out;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

function audit(line: string): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // audit is best-effort, never block a call on it
  }
}
