/**
 * The tools rcode rides, and the release we have already reviewed.
 * Bump `seen` after looking at a newer release. `rcode ahead` prints anything past it.
 *
 * ride "guest": we shell out to their CLI, so a new model or tool is used on the next turn.
 * ride "protocol": any agent speaking it is a guest. A message we do not know yet is shown, not dropped.
 * ride "watch": we do not run their app. A new release is a prompt to look, then to stay ahead of it.
 */
export type Ride = "guest" | "protocol" | "watch";

export interface Upstream {
  id: string;
  repo: string;
  ride: Ride;
  seen: string;
  ours: string;
}

export const UPSTREAMS: Upstream[] = [
  {
    id: "claude",
    repo: "anthropics/claude-code",
    ride: "guest",
    seen: "v2.1.319",
    ours: "Picking Claude plan uses whatever Claude Code is installed. Receipts and threat rules stay around rcode's own turns.",
  },
  {
    id: "codex",
    repo: "openai/codex",
    ride: "guest",
    seen: "rust-v0.167.0",
    ours: "Picking Codex plan uses whatever Codex is installed, sandboxed to the folder.",
  },
  {
    id: "acp",
    repo: "agentclientprotocol/agent-client-protocol",
    ride: "protocol",
    seen: "schema-v1.30.0",
    ours: "Any agent that speaks the protocol can take a turn, and it still asks you before it acts.",
  },
  {
    id: "t3",
    repo: "pingdotgg/t3code",
    ride: "watch",
    seen: "v0.1.7",
    ours: "No account. The center has skins, missions, receipts, and any protocol agent.",
  },
];
