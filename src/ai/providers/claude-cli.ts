/**
 * Claude subscription bridge, thinking only.
 *
 * rcode keeps its tools, permissions, guards and receipts. The `claude` CLI, signed in with the
 * user's own Claude plan, supplies each model turn with its built-in tools switched off
 * (`--tools ""`). Tool calls travel as text:
 *   model → <tool_call name="edit">{"path":"a.ts",…}</tool_call>
 *   rcode runs the tool and sends back a <tool_result> block in the next turn.
 *
 * rcode never reads Claude credentials. The CLI does its own sign-in (`claude` → /login).
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Model, StreamOptions, ToolSchema } from "../types.ts";
import { computeCost } from "../types.ts";
import { AssistantStream, MessageBuilder } from "../stream.ts";

export const claudeBin = () => process.env.RCODE_CLAUDE_BIN ?? "claude";

const CALL_RE = /<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/g;

export interface ParsedTurn { text: string; calls: Array<{ name: string; args: Record<string, unknown> }> }

/** Pull tool calls out of a reply. Anything the model wrote as a tool result is dropped. */
export function parseToolCalls(raw: string): ParsedTurn {
  const cut = raw.search(/<tool_result[\s>]/);
  const body = cut >= 0 ? raw.slice(0, cut) : raw;
  const calls: ParsedTurn["calls"] = [];
  const text = body.replace(CALL_RE, (_m, name: string, json: string) => {
    let args: Record<string, unknown>;
    try { args = JSON.parse(json.trim() || "{}"); } catch { args = { __invalid_json: json.trim().slice(0, 500) }; }
    calls.push({ name, args });
    return "";
  }).trim();
  return { text, calls };
}

const textOf = (content: Message["content"]) =>
  content.map((c: any) => (c.type === "text" ? c.text : c.type === "image" ? "[image omitted]" : "")).join("");

/** The whole conversation as one prompt. Each turn is stateless, so this is the memory. */
export function renderTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user") parts.push(`USER:\n${textOf(m.content)}`);
    else if (m.role === "assistant") {
      const bits = m.content.map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `<tool_call name="${c.name}">${JSON.stringify(c.arguments ?? {})}</tool_call>` : "")).filter(Boolean);
      parts.push(`ASSISTANT:\n${bits.join("\n")}`);
    } else {
      const err = (m as any).isError ? ' status="error"' : "";
      parts.push(`<tool_result name="${(m as any).toolName}"${err}>\n${textOf(m.content)}\n</tool_result>`);
    }
  }
  return parts.join("\n\n");
}

/** Describes the text tool protocol and the available tools. Empty when there are no tools. */
export function toolProtocol(tools: ToolSchema[] = []): string {
  if (!tools.length) return "";
  const list = tools.map((t) => `- ${t.name}: ${String(t.description ?? "").split("\n")[0]}\n  parameters: ${JSON.stringify(t.parameters)}`).join("\n");
  return [
    "# Tools",
    "You act only through tools. To call one, reply with a block exactly like:",
    '<tool_call name="TOOL_NAME">{"arg": "value"}</tool_call>',
    "You may write several blocks; they run in order. Then stop and wait.",
    "Results come back in a <tool_result> block on the next turn. Never write a <tool_result> yourself.",
    "When the task is finished, reply in plain text with no tool_call block.",
    "",
    "Tools:",
    list,
  ].join("\n");
}

/** A neutral working directory, so the CLI doesn't load CLAUDE.md files from the project or home. */
function neutralCwd(): string {
  const d = join(tmpdir(), "rcode-claude-cli");
  mkdirSync(d, { recursive: true });
  return d;
}

function friendlyError(raw: string): string {
  if (/authenticat|401|re-?authenticate|not logged in|login/i.test(raw)) {
    return "Claude isn't signed in on this computer. Run `claude`, type /login, finish the browser sign-in, then try again.";
  }
  return raw.trim().slice(0, 400) || "claude CLI returned no output";
}

export function streamClaudeCli(model: Model, ctx: Context, opts: StreamOptions): AssistantStream {
  const out = new AssistantStream();
  const b = new MessageBuilder(model, out);
  (async () => {
    try {
      const system = [ctx.systemPrompt, toolProtocol(ctx.tools)].filter(Boolean).join("\n\n");
      const prompt = `${renderTranscript(ctx.messages)}\n\nWrite the next ASSISTANT reply now.`;
      const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--model", model.id, `--system-prompt=${system}`];
      const raw = await new Promise<string>((resolve, reject) => {
        const child = spawn(claudeBin(), args, { cwd: neutralCwd(), stdio: ["pipe", "pipe", "pipe"], env: process.env });
        const onAbort = () => child.kill("SIGTERM");
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        let stdout = "", stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e: any) => reject(new Error(e?.code === "ENOENT"
          ? "claude CLI not found. Install Claude Code (https://claude.ai/install.sh) or set RCODE_CLAUDE_BIN."
          : e.message)));
        child.on("close", (code) => {
          opts.signal?.removeEventListener("abort", onAbort);
          if (opts.signal?.aborted) return reject(new Error("aborted"));
          if (!stdout.trim()) return reject(new Error(friendlyError(stderr || `claude exited with ${code}`)));
          resolve(stdout);
        });
        child.stdin.end(prompt);
      });

      const res = JSON.parse(raw);
      if (res.is_error || res.subtype !== "success") throw new Error(friendlyError(String(res.result ?? res.subtype ?? "")));
      const turn = parseToolCalls(String(res.result ?? ""));

      b.start();
      if (turn.text) b.text(b.msg.content.length, turn.text);
      for (const call of turn.calls) {
        const i = b.msg.content.length;
        b.toolStart(i, `claude_${Date.now().toString(36)}_${i}`, call.name);
        b.toolDelta(i, JSON.stringify(call.args));
        b.toolEnd(i, () => call.args);
      }
      const u = res.usage ?? {};
      b.usage({
        input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      });
      computeCost(model, b.msg.usage); // subscription: the model's price is $0, so no per-token charge shows
      b.finish();
    } catch (e) {
      b.fail(e, !!opts.signal?.aborted);
    }
  })();
  return out;
}
