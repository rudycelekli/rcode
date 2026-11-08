import { VERSION } from "../version.ts";
/**
 * MCP client manager. Connects configured servers (stdio or streamable HTTP) in parallel,
 * exposes their tools as rcode tools named `mcp__<server>__<tool>`, and maps MCP annotations
 * (readOnlyHint / destructiveHint / openWorldHint) onto rcode's permission effects.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { Tool, ToolResult } from "../agent/types.ts";
import type { McpServerConfig } from "../config.ts";
import { truncateTail } from "../tools/util.ts";

export interface McpServerState { name: string; status: "connecting" | "ready" | "error" | "disabled"; error?: string; tools: number; client?: Client }

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

export class McpManager {
  servers = new Map<string, McpServerState>();
  private tools: Tool[] = [];
  private listeners = new Set<() => void>();

  constructor(private configs: Record<string, McpServerConfig>, private cwd: string) {}

  onChange(l: () => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  getTools(): Tool[] { return this.tools; }

  async connectAll(timeoutMs = 30_000): Promise<void> {
    await Promise.all(Object.entries(this.configs).map(([name, cfg]) => this.connect(name, cfg, timeoutMs)));
  }

  private async connect(name: string, cfg: McpServerConfig, timeoutMs: number) {
    if (cfg.enabled === false) { this.servers.set(name, { name, status: "disabled", tools: 0 }); return; }
    const st: McpServerState = { name, status: "connecting", tools: 0 };
    this.servers.set(name, st);
    try {
      const client = new Client({ name: "rcode", version: VERSION }, { capabilities: {} });
      const transport = cfg.url
        ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } })
        : new StdioClientTransport({ command: cfg.command!, args: cfg.args ?? [], env: { ...(process.env as Record<string, string>), ...cfg.env }, cwd: this.cwd, stderr: "ignore" });
      await withTimeout(client.connect(transport), cfg.timeoutMs ?? timeoutMs, `connect ${name}`);
      const listed = await withTimeout(client.listTools(), cfg.timeoutMs ?? timeoutMs, `list tools ${name}`);
      const allow = cfg.tools?.map((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
      const mine = listed.tools.filter((t) => !allow || allow.some((r) => r.test(t.name))).map((t) => this.wrap(name, client, t, cfg.timeoutMs));
      this.tools = [...this.tools.filter((t) => !t.name.startsWith(`mcp__${sanitize(name)}__`)), ...mine];
      Object.assign(st, { status: "ready", tools: mine.length, client });
    } catch (e) {
      Object.assign(st, { status: "error", error: (e as Error).message });
    }
    for (const l of this.listeners) l();
  }

  private wrap(server: string, client: Client, t: any, timeoutMs = 120_000): Tool {
    const ann = t.annotations ?? {};
    const inputSchema = t.inputSchema ?? { type: "object", properties: {} };
    // Pass JSON Schema through verbatim; validate loosely (server validates strictly).
    const schema = z.record(z.string(), z.unknown());
    return {
      name: `mcp__${sanitize(server)}__${sanitize(t.name)}`,
      label: `${server}:${t.name}`,
      description: `[MCP ${server}] ${(t.description ?? t.name).slice(0, 2000)}`,
      schema,
      jsonSchema: inputSchema,
      concurrency: ann.readOnlyHint ? "shared" : "exclusive",
      effects: { readOnly: !!ann.readOnlyHint, destructive: !!ann.destructiveHint, network: ann.openWorldHint !== false && !ann.readOnlyHint ? true : !!ann.openWorldHint, runsProcess: !ann.readOnlyHint },
      summarize: (a) => JSON.stringify(a).slice(0, 120),
      async execute(args, ctx): Promise<ToolResult> {
        const res: any = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }, undefined, { signal: ctx.signal, timeout: timeoutMs });
        const content: ToolResult["content"] = [];
        for (const c of res.content ?? []) {
          if (c.type === "text") content.push({ type: "text", text: c.text });
          else if (c.type === "image") content.push({ type: "image", mimeType: c.mimeType, data: c.data });
          else if (c.type === "resource") content.push({ type: "text", text: c.resource?.text ?? `[resource ${c.resource?.uri}]` });
          else content.push({ type: "text", text: JSON.stringify(c) });
        }
        if (!content.length && res.structuredContent) content.push({ type: "text", text: JSON.stringify(res.structuredContent, null, 2) });
        for (const c of content) if (c.type === "text") c.text = truncateTail(c.text, `mcp-${server}`).text;
        return { content, isError: !!res.isError };
      },
    };
  }

  async close() {
    await Promise.all([...this.servers.values()].map((s) => s.client?.close().catch(() => {})));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);
}
