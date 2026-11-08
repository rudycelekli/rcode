/**
 * Built-in model catalog. Users extend/override it with ~/.rcode/models.json or
 * `rcode models refresh` (pulls models.dev for pricing/context of everything else).
 * Any "provider/model-id" string resolves: unknown ids on a known provider get sane defaults.
 */
import type { ApiId, Model } from "./types.ts";

interface ProviderDef { api: ApiId; baseUrl: string; envKeys: string[]; compat?: Model["compat"]; headers?: Record<string, string> }

export const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] },
  openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", envKeys: ["OPENAI_API_KEY"], compat: { supportsDeveloperRole: true } },
  google: { api: "google-gemini", baseUrl: "https://generativelanguage.googleapis.com", envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  openrouter: { api: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", envKeys: ["OPENROUTER_API_KEY"] },
  groq: { api: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", envKeys: ["GROQ_API_KEY"] },
  xai: { api: "openai-chat", baseUrl: "https://api.x.ai/v1", envKeys: ["XAI_API_KEY"] },
  deepseek: { api: "openai-chat", baseUrl: "https://api.deepseek.com/v1", envKeys: ["DEEPSEEK_API_KEY"] },
  mistral: { api: "openai-chat", baseUrl: "https://api.mistral.ai/v1", envKeys: ["MISTRAL_API_KEY"] },
  cerebras: { api: "openai-chat", baseUrl: "https://api.cerebras.ai/v1", envKeys: ["CEREBRAS_API_KEY"] },
  together: { api: "openai-chat", baseUrl: "https://api.together.xyz/v1", envKeys: ["TOGETHER_API_KEY"] },
  fireworks: { api: "openai-chat", baseUrl: "https://api.fireworks.ai/inference/v1", envKeys: ["FIREWORKS_API_KEY"] },
  ollama: { api: "ollama", baseUrl: process.env.OLLAMA_HOST ? `${process.env.OLLAMA_HOST.replace(/\/$/, "")}/v1` : "http://localhost:11434/v1", envKeys: [] },
  faux: { api: "faux", baseUrl: "", envKeys: [] },
  lmstudio: { api: "openai-chat", baseUrl: "http://localhost:1234/v1", envKeys: [] },
};

type Spec = [id: string, name: string, ctx: number, maxOut: number, cost: [number, number, number, number], flags?: Partial<Model>];

// cost = [input, output, cacheRead, cacheWrite] $/MTok
const CATALOG: Record<string, Spec[]> = {
  anthropic: [
    ["claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 128_000, [4, 20, 0.2, 5], { reasoning: true, thinkingMode: "always" }],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, 128_000, [2, 10, 0.2, 2.5], { reasoning: true, thinkingMode: "adaptive" }],
    ["claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000, 128_000, [0.1, 0.5, 0.01, 0.125], { reasoning: true, thinkingMode: "adaptive" }],
    ["claude-fable-5-1", "Claude Fable 5.1", 1_000_000, 128_000, [10, 50, 0.25, 12.5], { reasoning: true, thinkingMode: "always" }],
    ["claude-opus-5", "Claude Opus 5", 1_000_000, 128_000, [5, 25, 0.5, 6.25], { reasoning: true, thinkingMode: "adaptive" }],
    ["claude-sonnet-5", "Claude Sonnet 5", 1_000_000, 128_000, [2, 10, 0.2, 2.5], { reasoning: true, thinkingMode: "adaptive" }],
    ["claude-opus-4-8", "Claude Opus 4.8", 1_000_000, 128_000, [5, 25, 0.5, 6.25], { reasoning: true, thinkingMode: "adaptive" }],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, 128_000, [3, 15, 0.3, 3.75], { reasoning: true, thinkingMode: "adaptive" }],
    ["claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000, [1, 5, 0.1, 1.25], { reasoning: true, thinkingMode: "budget" }],
  ],
  openai: [
    ["gpt-5", "GPT-5", 400_000, 128_000, [1.25, 10, 0.125, 0], { reasoning: true, thinkingMode: "effort" }],
    ["gpt-5-mini", "GPT-5 mini", 400_000, 128_000, [0.25, 2, 0.025, 0], { reasoning: true, thinkingMode: "effort" }],
    ["gpt-5-nano", "GPT-5 nano", 400_000, 128_000, [0.05, 0.4, 0.005, 0], { reasoning: true, thinkingMode: "effort" }],
    ["gpt-4.1", "GPT-4.1", 1_047_576, 32_768, [2, 8, 0.5, 0], { reasoning: false }],
    ["gpt-4.1-mini", "GPT-4.1 mini", 1_047_576, 32_768, [0.4, 1.6, 0.1, 0], { reasoning: false }],
    ["o4-mini", "o4-mini", 200_000, 100_000, [1.1, 4.4, 0.275, 0], { reasoning: true, thinkingMode: "effort" }],
  ],
  google: [
    ["gemini-2.5-pro", "Gemini 2.5 Pro", 1_048_576, 65_536, [1.25, 10, 0.31, 0], { reasoning: true }],
    ["gemini-2.5-flash", "Gemini 2.5 Flash", 1_048_576, 65_536, [0.3, 2.5, 0.075, 0], { reasoning: true }],
  ],
  deepseek: [["deepseek-chat", "DeepSeek V3", 128_000, 8_192, [0.27, 1.1, 0.07, 0]], ["deepseek-reasoner", "DeepSeek R1", 128_000, 32_768, [0.55, 2.19, 0.14, 0], { reasoning: true }]],
  xai: [["grok-4", "Grok 4", 256_000, 64_000, [3, 15, 0.75, 0], { reasoning: true }]],
};

function build(provider: string, s: Spec): Model {
  const p = PROVIDERS[provider]!;
  const [id, name, contextWindow, maxOutput, [input, output, cacheRead, cacheWrite], flags] = s;
  return { id, name, provider, api: p.api, baseUrl: p.baseUrl, contextWindow, maxOutput, reasoning: false, vision: true, cost: { input, output, cacheRead, cacheWrite }, envKeys: p.envKeys, compat: p.compat, headers: p.headers, ...flags };
}

const registry = new Map<string, Model>();
for (const [prov, specs] of Object.entries(CATALOG)) for (const s of specs) { const m = build(prov, s); registry.set(`${prov}/${m.id}`, m); }

export function registerModel(m: Model) { registry.set(`${m.provider}/${m.id}`, m); }
export function allModels(): Model[] { return [...registry.values()]; }

/** Resolve "provider/model", a bare id, or an alias. Unknown ids on known providers get defaults. */
export function resolveModel(ref: string): Model | undefined {
  const alias = ALIASES[ref];
  if (alias) ref = alias;
  if (registry.has(ref)) return registry.get(ref);
  const bare = [...registry.values()].find((m) => m.id === ref);
  if (bare) return bare;
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const prov = ref.slice(0, slash), id = ref.slice(slash + 1);
    if (PROVIDERS[prov]) {
      const reasoning = /(^o\d|gpt-5|reason|r1|think|claude-(opus|sonnet|haiku|fable)-[4-9])/i.test(id);
      return build(prov, [id, id, prov === "ollama" || prov === "lmstudio" ? 32_768 : 128_000, 16_384, [0, 0, 0, 0], { reasoning, ...(prov === "anthropic" && reasoning ? { thinkingMode: "adaptive" } : {}) }]);
    }
  }
  return undefined;
}

export const ALIASES: Record<string, string> = {
  opus: "anthropic/claude-opus-5-5",
  sonnet: "anthropic/claude-sonnet-5-5",
  haiku: "anthropic/claude-haiku-5-5",
  fable: "anthropic/claude-fable-5-1",
  gpt5: "openai/gpt-5",
  "gpt-5": "openai/gpt-5",
  mini: "openai/gpt-5-mini",
  gemini: "google/gemini-2.5-pro",
  flash: "google/gemini-2.5-flash",
};

export function apiKeyFor(model: Model, overrides: Record<string, string> = {}): string | undefined {
  if (overrides[model.provider]) return overrides[model.provider];
  for (const k of model.envKeys) if (process.env[k]) return process.env[k];
  return undefined;
}

/** Pick a sensible default given which credentials exist. */
export function defaultModelRef(overrides: Record<string, string> = {}): string {
  const has = (p: string) => !!overrides[p] || PROVIDERS[p]!.envKeys.some((k) => process.env[k]);
  if (has("anthropic")) return "anthropic/claude-opus-5-5";
  if (has("openai")) return "openai/gpt-5";
  if (has("google")) return "google/gemini-2.5-pro";
  if (has("openrouter")) return "openrouter/anthropic/claude-opus-5-5";
  return "ollama/qwen3-coder";
}

/** Pull models.dev for live pricing/context and merge (non-destructive). */
export async function refreshFromModelsDev(): Promise<number> {
  const res = await fetch("https://models.dev/api.json");
  const data: any = await res.json();
  let n = 0;
  for (const [prov, pdata] of Object.entries<any>(data)) {
    if (!PROVIDERS[prov]) continue;
    for (const [id, m] of Object.entries<any>(pdata.models ?? {})) {
      const key = `${prov}/${id}`;
      const existing = registry.get(key);
      const c = m.cost ?? {};
      registry.set(key, {
        ...(existing ?? build(prov, [id, m.name ?? id, 128_000, 16_384, [0, 0, 0, 0]])),
        name: m.name ?? existing?.name ?? id,
        contextWindow: m.limit?.context ?? existing?.contextWindow ?? 128_000,
        maxOutput: m.limit?.output ?? existing?.maxOutput ?? 16_384,
        reasoning: m.reasoning ?? existing?.reasoning ?? false,
        vision: (m.modalities?.input ?? []).includes("image") || (existing?.vision ?? false),
        cost: { input: c.input ?? existing?.cost.input ?? 0, output: c.output ?? existing?.cost.output ?? 0, cacheRead: c.cache_read ?? existing?.cost.cacheRead ?? 0, cacheWrite: c.cache_write ?? existing?.cost.cacheWrite ?? 0 },
      });
      n++;
    }
  }
  return n;
}

/** Cheap sibling model on the same provider (cost router for subagents, summaries, memory capture). */
export const FAST_MODEL: Record<string, string> = {
  anthropic: "anthropic/claude-haiku-5-5",
  openai: "openai/gpt-5-mini",
  google: "google/gemini-2.5-flash",
  openrouter: "openrouter/anthropic/claude-haiku-5-5",
  deepseek: "deepseek/deepseek-chat",
};

export function resolveTier(tier: string | undefined, main: Model, smallModel?: string): Model {
  if (!tier || tier === "inherit" || tier === "smart") return main;
  if (tier === "fast") return (smallModel && resolveModel(smallModel)) || (FAST_MODEL[main.provider] && resolveModel(FAST_MODEL[main.provider]!)) || main;
  return resolveModel(tier) ?? main;
}
