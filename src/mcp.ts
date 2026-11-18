import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { checkTool, redact } from "./policy.js";

/**
 * Claude Code's own tools (Bash, Read, Edit, ...) over MCP, via `claude mcp serve`.
 * Only allowlisted tools are exposed, every call passes the policy, and every call is audited.
 */
export interface McpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpOptions {
  claudeBin: string;
  cwd: string;
  allow: string[];
  timeoutMs: number;
  auditDir?: string;
}

const RESULT_CAP = 8000;

export class ClaudeMcp {
  private client: Client | null = null;
  private tools: McpTool[] = [];
  private readonly auditFile: string;

  constructor(private readonly opts: McpOptions) {
    const dir = opts.auditDir ?? join(homedir(), ".jarvis");
    this.auditFile = join(dir, "audit.log");
  }

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.opts.claudeBin,
      args: ["mcp", "serve"],
      cwd: this.opts.cwd,
      stderr: "ignore",
    });
    const client = new Client({ name: "jarvis-voice", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const allow = new Set(this.opts.allow);
    this.tools = tools
      .filter((t) => allow.has(t.name))
      .map((t) => ({
        name: t.name,
        description: (t.description ?? "").slice(0, 1000),
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
    this.client = client;
    this.audit(`connected; tools=${this.tools.map((t) => t.name).join(",")}`);
  }

  get connected(): boolean {
    return this.client !== null && this.tools.length > 0;
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  /** Run one tool. Returns text for the model; never throws for policy blocks or tool errors. */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) return "ERROR: Claude Code tools are not connected.";
    if (!this.tools.some((t) => t.name === name)) return `ERROR: tool ${name} is not available.`;
    const blocked = checkTool(name, args, this.opts.cwd);
    this.audit(`${blocked ? "BLOCKED" : "call"} ${name} ${redact(JSON.stringify(args)).slice(0, 400)}`);
    if (blocked) return blocked;
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.opts.timeoutMs });
      const text = ((result.content as { type: string; text?: string }[]) ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      const out = text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) + "\n[cut]" : text;
      this.audit(`result ${name} ${out.length} chars${result.isError ? " ERROR" : ""}`);
      return result.isError ? `ERROR: ${out}` : out;
    } catch (err) {
      const msg = redact((err as Error).message);
      this.audit(`failed ${name}: ${msg}`);
      return `ERROR: ${msg}`;
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  private audit(line: string): void {
    try {
      mkdirSync(join(this.auditFile, ".."), { recursive: true });
      appendFileSync(this.auditFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Auditing is best-effort; it must never block a tool call.
    }
  }
}
