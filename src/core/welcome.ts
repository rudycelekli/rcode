/**
 * Zero-config start: find a model without asking, accept a pasted API key as an answer,
 * and offer project-aware first prompts. Nothing here talks to a model.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS } from "../ai/models.ts";

/** Key prefixes, most specific first. The whole input must be the key — never sniff inside prose. */
const KEY_SHAPES: Array<[RegExp, string]> = [
  [/^sk-ant-[\w-]{20,}$/, "anthropic"],
  [/^sk-or-[\w-]{20,}$/, "openrouter"],
  [/^sk-(proj-|svcacct-)?[\w-]{20,}$/, "openai"],
  [/^AIza[\w-]{30,}$/, "google"],
  [/^gsk_\w{20,}$/, "groq"],
  [/^xai-\w{20,}$/, "xai"],
  [/^csk-\w{20,}$/, "cerebras"],
];

export function keyProvider(text: string): { provider: string; key: string } | undefined {
  const key = text.trim();
  if (/\s/.test(key)) return undefined;
  for (const [re, provider] of KEY_SHAPES) if (re.test(key)) return { provider, key };
  return undefined;
}

export function hasCloudKey(auth: Record<string, string>): boolean {
  return Object.entries(PROVIDERS).some(([p, d]) => d.envKeys.length > 0 && (!!auth[p] || d.envKeys.some((k) => process.env[k])));
}

/** Best coding model among what's installed locally; embedding models can't chat. */
const LOCAL_PREFERENCE = [/qwen3-coder/, /devstral/, /qwen2\.5-coder/, /gpt-oss/, /codestral/, /deepseek-coder/, /qwen3/, /llama3/, /mistral/, /gemma/];
export function rankLocal(names: string[]): string | undefined {
  const chat = names.filter((n) => !/embed|bge|minilm|nomic|rerank/i.test(n));
  for (const re of LOCAL_PREFERENCE) { const hit = chat.find((n) => re.test(n)); if (hit) return hit; }
  return chat[0];
}

async function listJson(url: string, pick: (j: any) => string[], ms: number): Promise<string[] | undefined> {
  try { return pick(await (await fetch(url, { signal: AbortSignal.timeout(ms) })).json()); } catch { return undefined; }
}

export async function detectLocal(ms = 600): Promise<{ ollama?: string[]; lmstudio?: string[] }> {
  const ollamaBase = PROVIDERS.ollama!.baseUrl.replace(/\/v1\/?$/, "");
  const [ollama, lmstudio] = await Promise.all([
    listJson(`${ollamaBase}/api/tags`, (j) => (j.models ?? []).map((m: any) => String(m.name)), ms),
    listJson(`${PROVIDERS.lmstudio!.baseUrl}/models`, (j) => (j.data ?? []).map((m: any) => String(m.id)), ms),
  ]);
  return { ollama, lmstudio };
}

/** A model ref that works right now without credentials, or undefined when nothing local is running. */
export async function localStartModel(): Promise<string | undefined> {
  const { ollama, lmstudio } = await detectLocal();
  const o = rankLocal(ollama ?? []);
  if (o) return `ollama/${o}`;
  const l = rankLocal(lmstudio ?? []);
  if (l) return `lmstudio/${l}`;
  return undefined;
}

export const WELCOME = [
  "Welcome to rcode. It needs an AI model to think with. Pick one:",
  "  • Paste any API key right here (Anthropic, OpenAI, Google, OpenRouter, Groq, xAI).",
  "    It is saved on this computer only and never sent to a model.",
  "  • Free and private: install Ollama (ollama.com), run `ollama pull qwen3-coder`, restart rcode.",
];

/** Three first prompts that make sense for what's in this folder. */
export function starterIdeas(cwd: string): string[] {
  let files: string[] = [];
  try { files = readdirSync(cwd).filter((f) => !f.startsWith(".")); } catch {}
  if (!files.length) return [
    "Build me a simple one-page website for my small business",
    "Write a script that renames my photos by the date they were taken",
    "Help me plan a new project and set up the folder",
  ];
  const ideas = ["Explain what this project does, in plain English"];
  const has = (f: string) => existsSync(join(cwd, f));
  let testable = has("pyproject.toml") || has("Cargo.toml") || has("go.mod");
  if (has("package.json")) { try { testable ||= !!JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts?.test; } catch {} }
  if (testable) ideas.push("Run the tests and fix anything that fails");
  if (has(".git")) ideas.push("Review my uncommitted changes and point out bugs");
  ideas.push("Find the riskiest part of this code and suggest one improvement");
  return ideas.slice(0, 3);
}
