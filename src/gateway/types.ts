/** Channel adapter contract for `rcode gateway` (Telegram, web, Slack, Discord, …). */

export interface IncomingMessage {
  channel: string;
  /** Resolved by the gateway core: "owner" (may approve / change settings), "user" (chat only), "scheduler". */
  role?: "owner" | "user" | "scheduler";
  /** Conversation key (chat id, or chat id + thread id). One rcode session per conversation. */
  conversationId: string;
  userId: string;
  userName?: string;
  text: string;
  images?: Array<{ mimeType: string; data: string }>;
  /** Raw platform message id (for replies). */
  messageId?: string;
}

export interface ApprovalRequest { id: string; title: string; reason: string; /** Exact command / arguments being approved. */ detail?: string }

export interface OutgoingHandle {
  /** Replace the message text (streaming). Adapters rate-limit internally. */
  update(text: string): Promise<void>;
  /** Final text; adapters may split long messages. */
  finish(text: string): Promise<void>;
}

export interface ChannelAdapter {
  readonly name: string;
  start(onMessage: (m: IncomingMessage) => void, onApproval: (approvalId: string, decision: "allow" | "allow-session" | "deny", userId: string, conversationId: string) => void): Promise<void>;
  stop(): Promise<void>;
  /** Start a streaming reply in a conversation. */
  reply(conversationId: string, initial: string): Promise<OutgoingHandle>;
  send(conversationId: string, text: string): Promise<void>;
  askApproval(conversationId: string, req: ApprovalRequest): Promise<void>;
  typing?(conversationId: string): Promise<void>;
}

export interface GatewayConfig {
  /** Per-channel settings. */
  telegram?: { token?: string; allowedUsers?: string[]; owners?: string[] };
  slack?: { botToken?: string; appToken?: string; allowedUsers?: string[]; owners?: string[] };
  discord?: { token?: string; allowedUsers?: string[]; owners?: string[] };
  web?: { port?: number; host?: string; token?: string };
  /** Working directory for sessions (default: cwd where the gateway starts). */
  cwd?: string;
  /** Permission mode for remote sessions. "full" must be set explicitly. */
  mode?: "ask" | "auto-edit" | "full" | "plan";
  model?: string;
  /** Scheduled prompts: cron-ish "every 30m" / "daily 09:00". */
  schedules?: Array<{ every?: string; at?: string; prompt: string; conversation: string }>;
}

/** Auth hooks the core gives every adapter (adapters only translate; the core decides). */
export interface ChannelAuth {
  isAllowed(userId: string): boolean;
  /** Message from an unknown user in a private chat. Returns a reply to send, or undefined to stay silent. */
  onUnknown(userId: string, userName: string | undefined, text: string): string | undefined;
}
