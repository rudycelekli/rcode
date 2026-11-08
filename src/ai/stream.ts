import type { AssistantMessage, Model, StreamEvent, ToolCallPart, Usage } from "./types.ts";
import { emptyUsage } from "./types.ts";

/**
 * A push-based async iterable of StreamEvents with a `result()` promise that
 * resolves to the final AssistantMessage. Providers push into it; consumers
 * `for await` it. It never rejects.
 */
export class AssistantStream implements AsyncIterable<StreamEvent> {
  private queue: StreamEvent[] = [];
  private waiters: Array<(v: IteratorResult<StreamEvent>) => void> = [];
  private closed = false;
  private final!: AssistantMessage;
  private resolveFinal!: (m: AssistantMessage) => void;
  private finalP = new Promise<AssistantMessage>((r) => (this.resolveFinal = r));

  push(e: StreamEvent) {
    if (this.closed) return;
    if (e.type === "done" || e.type === "error") {
      this.final = e.message;
      this.closed = true;
      this.resolveFinal(e.message);
    }
    const w = this.waiters.shift();
    if (w) w({ value: e, done: false });
    else this.queue.push(e);
    if (this.closed) for (const w2 of this.waiters.splice(0)) w2({ value: undefined as never, done: true });
  }

  result(): Promise<AssistantMessage> { return this.finalP; }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: () => {
        const e = this.queue.shift();
        if (e) return Promise.resolve({ value: e, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

/** Helper that builds the partial assistant message while a provider streams. */
export class MessageBuilder {
  msg: AssistantMessage;
  private toolArgBuf = new Map<number, string>();
  constructor(model: Model, readonly out: AssistantStream) {
    this.msg = { role: "assistant", content: [], provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
  }
  start() { this.out.push({ type: "start", partial: this.msg }); }
  text(index: number, delta: string) {
    let p = this.msg.content[index];
    if (!p) { p = { type: "text", text: "" }; this.msg.content[index] = p; }
    if (p.type === "text") p.text += delta;
    this.out.push({ type: "text_delta", index, delta, partial: this.msg });
  }
  thinking(index: number, delta: string, signature?: string) {
    let p = this.msg.content[index];
    if (!p) { p = { type: "thinking", thinking: "" }; this.msg.content[index] = p; }
    if (p.type === "thinking") { p.thinking += delta; if (signature) p.signature = signature; }
    if (delta) this.out.push({ type: "thinking_delta", index, delta, partial: this.msg });
  }
  toolStart(index: number, id: string, name: string) {
    this.msg.content[index] = { type: "toolCall", id, name, arguments: {} };
    this.toolArgBuf.set(index, "");
    this.out.push({ type: "toolcall_start", index, id, name, partial: this.msg });
  }
  toolDelta(index: number, delta: string) {
    this.toolArgBuf.set(index, (this.toolArgBuf.get(index) ?? "") + delta);
    this.out.push({ type: "toolcall_delta", index, delta, partial: this.msg });
  }
  toolEnd(index: number, parse: (s: string) => Record<string, unknown>) {
    const p = this.msg.content[index] as ToolCallPart | undefined;
    if (!p || p.type !== "toolCall") return;
    p.arguments = parse(this.toolArgBuf.get(index) ?? "");
    this.out.push({ type: "toolcall_end", index, toolCall: p, partial: this.msg });
  }
  rawToolArgs(index: number) { return this.toolArgBuf.get(index) ?? ""; }
  usage(u: Partial<Usage>) { Object.assign(this.msg.usage, u); }
  finish() {
    this.msg.content = this.msg.content.filter(Boolean);
    if (this.msg.stopReason === "stop" && this.msg.content.some((c) => c.type === "toolCall")) this.msg.stopReason = "toolUse";
    this.out.push({ type: "done", message: this.msg });
  }
  fail(err: unknown, aborted: boolean) {
    this.msg.content = this.msg.content.filter(Boolean);
    this.msg.stopReason = aborted ? "aborted" : "error";
    this.msg.errorMessage = aborted ? "Request aborted" : err instanceof Error ? err.message : String(err);
    this.out.push({ type: "error", message: this.msg });
  }
}
