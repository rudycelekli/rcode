# Context efficiency for coding agents: headroom deep dive, landscape, and an rcode design

Status: research note, 2026-11-07. The headroom reference is at `reference/headroom`
(headroomlabs-ai/headroom, Apache-2.0, PyPI/npm `headroom-ai` v0.43.x). I read it but did not install
or run it. Numbers marked "reported" are the project's own claims, not ones I reproduced.

Current rcode baseline (what this note builds on):

| Concern | Where | Today |
|---|---|---|
| Whole-history compaction | `src/session/compaction.ts`, `src/core/session.ts:176-253` | LLM summary once context passes min(window − 16k, 85% of window); keeps about the last 20k tokens; chars/3.6 token estimate |
| Command output | `src/tools/util.ts` `truncateTail` | keeps the tail (2000 lines / 50 KB) and spills the full output to `$TMPDIR/rcode-output/*.log` |
| File reads | `src/tools/read.ts` | 2000 lines / 50 KB / 2000 chars per line, with an exact continuation offset |
| Cache layout | `src/ai/providers/anthropic.ts` | breakpoints on the system prompt, the last tool, and the last user message; `prompt_cache_key = sessionId` for OpenAI |
| Context hook | `src/agent/loop.ts:83-84` | `maybeCompact` then `transformContext` run before every model call (`transformContext` is unused today) |

---

## 1. Headroom deep dive

### 1.1 What it is, in one paragraph

Headroom is a **local context-compression layer**. It is not a cache and not a model router, though it
contains small pieces of both. It rewrites the bulky parts of an LLM request (tool results, logs,
grep output, JSON arrays, diffs, HTML, long text) into smaller, type-aware forms before the request
reaches the provider. It stores the originals locally so the model can fetch them back through an
injected `headroom_retrieve` tool ("CCR", Compress-Cache-Retrieve). It is built to keep the provider's
**prompt-cache prefix byte-identical**, so in the default mode it compresses only the newest content
(the "live zone"). There are four ways to plug it in, all running the same pipeline:

1. **Proxy** (`headroom proxy --port 8787`). A FastAPI app (`headroom/proxy/server.py`), with a Rust proxy
   being built in parallel (`crates/headroom-proxy`). It serves `/v1/messages`, `/v1/chat/completions`,
   `/v1/responses`, `/v1/compress`, `/v1/retrieve/{hash}`, `/health`, `/stats` and a dashboard.
   Clients only change their base URL, for example `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.
2. **Agent wrap** (`headroom wrap claude|codex|aider|opencode|omp|…`). Starts a session-scoped proxy,
   points the agent at it, and also registers Serena (an LSP symbol MCP server) for code navigation.
3. **Library**. Python `from headroom import compress` runs in-process. The **npm `headroom-ai` SDK is a
   thin client that sends messages to the proxy's `/v1/compress`**
   (`sdk/typescript/src/compress.ts:12-19`; `package.json` description). The TS SDK compresses nothing
   locally, so rcode cannot use headroom in-process without Python.
4. **MCP server** (`headroom mcp install`) with the tools `headroom_compress`, `headroom_retrieve` and
   `headroom_stats` (`headroom/ccr/mcp_server.py`, `docs/content/docs/mcp.mdx`).

Smaller extras: cross-agent memory (`headroom/memory`), `headroom learn`, which mines failed sessions
into `CLAUDE.md`/`AGENTS.md` (`headroom/learn`), and output-verbosity steering
(`headroom/proxy/output_steering.py`).

### 1.2 Architecture (request lifecycle)

```
client ──► proxy handler (anthropic / openai / responses / gemini / bedrock)
            │  compute frozen prefix from client cache_control markers
            │  identify LIVE ZONE = blocks after the frozen floor, up to and including the latest user msg
            ▼
          Transform pipeline (headroom/transforms/pipeline.py)
            1. tool-result interceptors (canary only; e.g. ast-grep Read outlining)
            2. CacheAligner – detector only, never rewrites (transforms/cache_aligner.py)
            3. ContentRouter – detect type → exactly one compressor (transforms/content_router.py)
                 SmartCrusher(JSON) · SearchCompressor · LogCompressor · DiffCompressor
                 HTMLExtractor · Tabular · Config · CodeCompressor(AST, gated) · TextCrusher
                 · DenseLineElider · Kompress (ModernBERT ONNX fallback)
            4. CCR store: original → hash (SQLite / LRU, TTL) + marker text in the block
            ▼
          inject headroom_retrieve tool; forward upstream; intercept retrieve calls in the response
          (ccr/response_handler.py) so the client never sees them
```

- Rust core (`crates/headroom-core/src/transforms/*`, exposed through PyO3 as `headroom._core`) holds
  SmartCrusher, search, log, diff, code and Kompress. The Python classes are shims. A parity suite
  (`crates/headroom-parity`) holds Python and Rust to byte-identical output.
- Live-zone logic: `crates/headroom-core/src/transforms/live_zone.rs` (module doc, lines 1-50) and
  `crates/headroom-proxy/src/compression/live_zone_{anthropic,openai,responses}.rs`. The floor is the
  message count frozen by explicit `cache_control` markers. The ceiling is the latest user message.
  The latest assistant message is never touched.
- Two modes (`docs/content/docs/architecture.mdx`). In **`cache`** (the default), only the new delta is
  compressed and earlier turns are forwarded byte-for-byte. **`token`** may recompress earlier turns
  and accepts cache busts in exchange for more raw savings.
- History is never dropped. Rolling-window and "intelligent context" scoring were removed ("PR-B1").
  Headroom treats message dropping as both a cache-killer and a quality risk.
- Fail-open everywhere. Bad JSON, a parse failure, or "output larger than input" all return the original.

### 1.3 Algorithms worth knowing (with file paths)

| Technique | File | How it works | Reported effect |
|---|---|---|---|
| **SmartCrusher** (JSON arrays) | `crates/headroom-core/src/transforms/smart_crusher/*`, `headroom/transforms/smart_crusher.py` | 1) Lossless first: a cleanly tabular array is re-encoded as a compact `csv-schema` table and kept if that saves ≥30%. 2) Otherwise keep/drop with an adaptive K: always keep error items, items >2σ outliers (numeric or length), change points, and BM25/embedding query matches. K is split 30% head, 15% tail, 55% by importance. Object keys are never dropped. | 26-54% on realistic non-duplicate arrays; 90%+ on repetitive ones (`docs/.../benchmarks.mdx`) |
| **Adaptive K** | `crates/headroom-core/src/transforms/adaptive_sizer.rs` | Kneedle "knee" on the cumulative unique-bigram coverage curve. SimHash fast path for near-duplicates. A zlib-ratio check bumps K by 20% when the kept subset is less diverse than the full set. | sets how many items to keep, statistically |
| **SearchCompressor** (grep/rg) | `.../search_compressor.rs` | Parses `file:line:content`, scores matches by query-word overlap plus line-importance signals, caps files / matches per file / total, adaptive K | ~91% on a synthetic 40-file corpus |
| **LogCompressor** | `.../log_compressor.rs` | Detects the format (pytest/npm/cargo/jest/make), classifies each line by level, tracks stack traces with per-language termination rules, keeps errors/fails/deduped warnings/traces/summaries plus a context window, adaptive cap. The omission marker counts levels among dropped lines only. | ~93% on a 1,000-line log |
| **DiffCompressor** | `.../diff_compressor.rs` | Caps files and hunks per file (first + last + top-scored middle), trims context lines | ~70% |
| **CodeCompressor** | `.../code_compressor.rs` | tree-sitter. Keeps imports, signatures, types and decorators; elides bodies; re-parses and returns the original on any ERROR node. **Gated off for recent code and when the user's prompt says fix/debug/review** (`wiki/LIMITATIONS.md`) | 0% on their Python benchmark by design |
| **Kompress** | `.../kompress.rs`; HF `chopratejas/kompress-v2-base` | ModernBERT-base fine-tune with a token keep/drop head and a span CNN head, run through ONNX int8. Keeps tokens scoring >0.5. Replaced their earlier LLMLingua-2 integration. | 6-24% on prose by default, ~40% at target 0.5 |
| **DenseLineElider** | `headroom/transforms/dense_line_elider.py` | Lines ≥300 chars with <6% spaces (minified JS, base64, RSC) keep a 160-char head and 80-char tail. Only fires when the block's dense lines total ≥2000 chars. Skips JSON-shaped lines and CJK text. | novel savings 7.2% → 25.1% on a replayed Codex web-research session |
| **Read lifecycle** | `headroom/transforms/read_lifecycle.py` | A Read is **STALE** if the file was edited afterwards and **SUPERSEDED** if it was re-read. Either case becomes a marker plus a CCR hash. Fresh reads are never touched. | "75% of Read output bytes" are stale (67%) or superseded (12%) on real traffic |
| **Read maturation** | `headroom/transforms/read_maturation.py` | Holds a read verbatim while the file is active. After `quiesce_turns` quiet turns it becomes a marker, **but only if the read is still outside the frozen cache prefix**. The doc explains why moving breakpoints to avoid this backfired. | qualitative |
| **Cross-turn dedup** | `headroom/transforms/cross_turn_dedup.py` | A large contiguous span (≥3 lines and enough chars) that appeared verbatim in an *earlier* tool output becomes an absolute pointer. Prefix-monotonic: block k's output never depends on later blocks, so appending turns never mutates earlier bytes. Keeps the earliest copy. | aimed at `cat` → `sed -n` → `git diff` → `cat` loops |
| **Lossless compaction** | `headroom/transforms/lossless_compaction.py` | Strips ANSI, collapses runs ("… repeated N times"), folds repeated blocks, groups grep output under file headings, strips diff index lines. Each transform has an exact inverse that is self-checked at runtime. | used in the marker-free `--lossless` mode |
| **Cold-prefix recompaction** | `headroom/transforms/cold_prefix.py` | When idle time exceeds the provider cache TTL, the cache is already gone, so it rewrites the whole prefix (dedup plus dropping superseded reads) and re-caches the smaller result | the right moment for history edits |
| **Thinking compaction** | `headroom/transforms/thinking_compactor.py` | Reports that on Claude 4.6+ prior-turn thinking is re-sent and **billed** (+688 to +995 tokens per block), and that editing a signed thinking block does nothing. The only levers are dropping it or converting it to a plain text block. Determinism (a memo keyed by content hash) keeps the prefix byte-stable. | reported, flag-gated |
| **Tool-schema compaction** | `headroom/proxy/tool_schema_compaction.py` | Strips `$schema`, `title` and `examples`, normalizes whitespace, optionally truncates descriptions to the first sentence. Cached by a digest of the tools array. | matters with more than 100 MCP tools |
| **Verbosity steering** | `headroom/proxy/output_steering.py` | Appends a byte-stable "be terse" block to the **end** of the system prompt so earlier cache breakpoints survive | output −31.7% (95% CI 27.7-35.7), **estimated**, not measured |
| **CCR** | `headroom/ccr/*`, `wiki/ccr.md` | The original is stored under a hash and the marker reads `[1000 items compressed to 20. Retrieve more: hash=…]`. The proxy injects `headroom_retrieve` and resolves those calls server-side. A context tracker can expand a block proactively when a later query mentions it. TOIN learns which fields get retrieved. | "zero-risk" in principle; depends on the model actually calling retrieve |

### 1.4 Measured results (reported by headroom)

- README proof table (`benchmarks/index_proof_table.py --seed 20260902`, provider tokenizer): code search
  21%, SRE incident 57%, codebase exploration 42%, GitHub triage 30%. The project's own rule
  (`AGENTS.md`) is that every savings claim must match this table: **21-57% on agent scenarios, 90%+ on
  repetitive JSON/logs, little on prose**.
- Latency: 0.2 ms p50 on 10K-token JSON, 1.4 ms at 100K. ContentRouter is 68-99% of pipeline time.
- Accuracy (N=100, within noise): GSM8K ±0, TruthfulQA +0.03, SQuAD v2 97% at 19% compression, BFCL 97% at
  32% compression. No coding-agent end-to-end solve-rate eval (SWE-bench style) is published.
- Code passes through (0%) by design. The authors argue that compressing code the agent is working on
  hurts. I agree.

### 1.5 Caveats that matter for rcode

- **Python runtime**. `[all]` is large and `[ml]` pulls in PyTorch/ONNX. This cannot be an "easy out of
  the box" dependency for a Bun binary. Treat it as an optional external.
- **Telemetry beacon is on by default** (`docs/content/docs/security-model.mdx:389-394`). Anonymous
  session summaries go to a Cloudflare worker. Opt out with `HEADROOM_BEACON=off`,
  `HEADROOM_TELEMETRY=off`, `DO_NOT_TRACK=1` or `HEADROOM_OFFLINE=1`. rcode must set these if it ever
  launches the proxy.
- **Subscription/OAuth risk**. Its own analysis (`docs/context-mode-integration-analysis.md`) lists
  header and `anthropic-beta` mutation as "fingerprint-class subscription-revocation risks" for OAuth
  CLIs. rcode supports `sk-ant-oat` OAuth (`anthropic.ts:22`), so the proxy must be opt-in and off for
  OAuth by default.
- Its main bug class has been **prompt-cache busting caused by request mutation**. Any wire-level
  rewriting rcode does inherits the same hazard. The fix is to shape content *before* it enters the
  transcript (section 3).
- The analysis contrasts headroom with **context-mode**, an admission-control layer at the tool
  boundary that keeps output out of context entirely. That layer is strictly cheaper and has no cache
  risk. rcode owns its tool boundary, so it can do context-mode-style shaping natively at no cost.

---

## 2. Landscape: techniques, what each buys, licenses

Rough classes of savings: **A** = admission (bytes never enter context), **B** = in-context
compression or pruning, **C** = billing (the same tokens at a cheaper rate), **D** = retrieval (fetch
less to begin with).

### 2.1 Summary table

| Technique / project | Class | Tokens saved | Quality impact | Cost to build in rcode | License |
|---|---|---|---|---|---|
| Provider prompt caching (Anthropic `cache_control`, OpenAI automatic + `prompt_cache_key`, Gemini implicit/explicit, DeepSeek automatic) | C | 0 tokens, but cached reads cost ~10% of input on Anthropic (writes 1.25× for 5 min, 2× for 1 h), 50-90% off on OpenAI depending on model, ~75% off on Gemini | none | low. Mostly layout discipline | n/a |
| Type-aware tool-output shaping (headroom ContentRouter, Codex head+tail truncation, oh-my-pi minimizer) | A/B | 50-95% on logs, grep, JSON and test output; ~0 on code and prose | low if errors and summaries are preserved and the full text stays retrievable | medium (pure TS, about 1-1.5k LOC) | headroom Apache-2.0 (port with NOTICE) |
| Stale/superseded read elision (headroom read_lifecycle, oh-my-pi read-supersede) | B | up to ~75% of read bytes on long sessions (headroom, reported) | ~none: the content is provably outdated or duplicated | low | Apache-2.0 / MIT |
| Observation masking (SWE-agent's "N lines omitted" for old observations; OpenHands `ObservationMaskingCondenser`; JetBrains 2025 study "The Complexity Trap") | B | roughly halves cost compared with an unmanaged context in that study | matched or slightly beat LLM summarization on SWE-bench Verified; summarization also made trajectories longer | low | SWE-agent MIT, OpenHands MIT |
| Anthropic server-side context editing (`clear_tool_uses` beta) | B | Anthropic reported 84% fewer tokens in a 100-turn eval | Anthropic reported +29% (+39% with the memory tool) on their agentic search eval | trivial, but Anthropic-only and opaque | API feature |
| LLM summarization compaction (rcode today, Claude Code `/compact`, OpenHands LLMSummarizingCondenser) | B | large (whole history → about 2-8k tokens) | lossy. Drift risk; costs an extra LLM call; forces a full cache rewrite | done | — |
| Cross-turn verbatim dedup (headroom) | B | workload-dependent; high in bash-heavy agents | none (pointer to an in-context original) | medium | Apache-2.0 |
| Repo map: aider (tree-sitter tags → file/identifier graph → personalized PageRank → budget-fitted map, default ~1k tokens) | D | replaces exploratory reads and greps; often saves several reads per task | positive for orientation and edit targeting; slightly worse if the map is stale or crowds the window | medium (web-tree-sitter WASM + tags queries + PageRank) | aider Apache-2.0; query files mostly MIT (from grammar repos) |
| Signature/outline views: repomix `--compress` (tree-sitter, keeps signatures), headroom CodeCompressor, ast-grep outlines | A/D | repomix claims ~70% on packed repos; huge for "understand this file" reads | bad when the agent needs bodies to edit, so it must be opt-in or an explicit mode | low-medium (shares the repo-map parser) | repomix MIT, ast-grep MIT |
| LSP/symbol tools: Serena (`find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `replace_symbol_body`) | D | reads a symbol instead of a file; large wins on big files | positive with accurate language servers; setup cost per language | high natively; low through MCP | Serena MIT |
| Semantic code search (embeddings over chunks): Cursor (Merkle-tree sync plus remote embeddings), Continue (LanceDB + local embeddings), Zilliz claude-context (MCP + Milvus) | D | fewer exploratory greps on huge or unfamiliar repos | mixed. Claude Code and Sourcegraph/Cody moved toward agentic grep plus graph because embedding retrieval goes stale and misses exact identifiers | high (index, sync, model) | various (Continue Apache-2.0, claude-context MIT) |
| Prompt compression: LLMLingua (small-LM perplexity token dropping; up to ~20× on reasoning prompts), LongLLMLingua (question-aware; ~4× fewer tokens with higher NaturalQuestions accuracy), LLMLingua-2 (BERT token classifier; 2-5× compression, 3-6× faster than v1); headroom Kompress | B | 2-20× on prose/RAG | **risky for code**: token deletion corrupts identifiers and syntax. Fine for docs, web pages and long prose tool output | high (model runtime) | LLMLingua MIT; Kompress weights per their HF card |
| Tool-definition diet: schema compaction, deferred/lazy tool loading (Anthropic tool search / `defer_loading`, oh-my-pi lazy `xd://` devices) | A | thousands of tokens per request once there are 50+ MCP tools | small risk the model doesn't find a tool | low-medium | — |
| Output-token reduction (verbosity steering; lower effort on routine turns) | — | output tokens, which cost ~5× input | small | trivial | — |
| Thinking-block hygiene (drop or convert prior-turn thinking at safe points) | B | hundreds to ~1k tokens per prior assistant turn on models that bill it (headroom, reported) | low for turns older than the current tool loop | low | — |
| Token counting (tiktoken / js-tiktoken / gpt-tokenizer for OpenAI o200k; Anthropic `count_tokens` endpoint; calibration from `usage`) | — | enables everything else: correct triggers and budgets | — | low | tiktoken MIT, gpt-tokenizer MIT |

### 2.2 Notes per technique

**Prompt caching (largest lever, already half-done in rcode).** The cache prefix order is tools →
system → messages. Any byte change invalidates everything after it. Facts to design around (verify
against current provider docs at implementation time):

- **Anthropic**: up to 4 breakpoints. 5-minute TTL refreshed on hit, or a 1-hour TTL at a higher write
  price. The lookup scans back about 20 content blocks from each breakpoint, so one breakpoint on the
  last user message can miss after a parallel batch with more than 20 tool results. There is a
  per-model minimum cacheable length (1024 tokens on Sonnet/Opus historically; higher on some newer
  models).
- **OpenAI**: automatic for prompts ≥1024 tokens, matched in 128-token steps. `prompt_cache_key`
  improves routing stickiness.
- **Gemini**: implicit caching on 2.5+ models, plus explicit `CachedContent`.
- **DeepSeek**: automatic disk cache.

The biggest practical losses are a volatile system prompt (date, git status, memory), tools that
reorder or change mid-session (MCP connect/disconnect), and history rewrites (compaction, pruning).

**Observation masking vs summarization.** The JetBrains study (Lindenbauer et al., 2025) found that
replacing all but the last ~10 observations with placeholders was as good as LLM summarization at about
half the cost of no management, and the hybrid did a bit better. SWE-agent has done this since 2024.
For rcode this means **mechanical pruning should be the first tier and LLM summarization the
backstop**, the reverse of today. Masking must still keep observations "recoverable": a placeholder
that says how to get the content back.

**Repo map (aider).** `aider/repomap.py` (Apache-2.0):

1. Extract `def`/`ref` tags per file with tree-sitter `tags.scm` queries.
2. Build a multigraph (referencing file → defining file, weighted by identifier).
3. Run personalized PageRank biased toward files in the chat and identifiers the user mentioned.
4. Rank `(file, ident)` definitions.
5. Binary-search the number of included tags to fit `--map-tokens` (default 1024; larger when no files
   are in the chat).
6. Render with a "tree context" (signature lines with `⋮` elisions).

Tags are cached by file mtime. What it buys is orientation without reads. It is the most-copied
context technique in the ecosystem, and it is pure computation with no LLM.

**Semantic search.** It helps on monorepos and on concept-level questions ("where do we rate-limit?").
It costs an embedding model, an index, incremental sync and staleness handling. Grep plus a repo map
plus symbol tools covers most coding-agent needs. Keep embeddings optional. rcode already has ruvector
for memory and can reuse it as the vector store.

**Prompt compression (LLMLingua family).** Best for long natural-language payloads such as web pages,
docs and RAG. Do not apply it to code, diffs, paths or identifiers. In a TS/Bun agent the runtime cost
(an ONNX model) argues for "only via external proxy" (headroom Kompress).

---

## 3. Design for rcode

Principles:

1. **Shape at the tool boundary, not on the wire.** Compress tool output once, when it is produced,
   before it enters the transcript. That is cache-safe by construction, because the bytes the provider
   caches are already the small ones. headroom has to compress on the wire because it is a proxy. rcode
   doesn't.
2. **Never lose information silently.** Everything elided is recoverable through a hash-addressed
   artifact the `read` tool understands (rcode's version of CCR, with no proxy round-trip).
3. **Mutate history only at "epochs".** Pruning old content changes the prefix. Do it rarely and in
   batches: when the cache is cold, or when savings exceed a threshold. Decisions are sticky and
   persisted, so later turns replay identical bytes.
4. **Mechanical first, LLM last.** Order: shaping → pruning/masking → summarization.
5. **Zero config.** Everything below defaults on, has no native deps (WASM only) and fails open.

### 3.1 New module layout

```
src/context/
  system-prompt.ts      (exists) – split into static + dynamic parts (3.5)
  tokens.ts             NEW – calibrated token counting
  artifacts.ts          NEW – hash-addressed spill store (CCR-equivalent)
  shape/                NEW – tool-output shaping (admission control)
    index.ts            detect → compressor → fallback head+tail
    log.ts  search.ts  diff.ts  json.ts  dense.ts  lossless.ts
  prune.ts              NEW – epoch-based history pruning (transformContext)
  cache.ts              NEW – cache-state tracking + layout helpers
  repomap/              NEW – tree-sitter tags, graph, PageRank, render
    tags.ts  rank.ts  render.ts  queries/*.scm
src/tools/repomap.ts    NEW – `repo_map` tool
src/tools/read.ts       (exists) – `outline` mode, artifact:// paths
src/tools/util.ts       (exists) – truncateTail → shapeOutput
src/session/compaction.ts (exists) – tiered: prune before summarize; cache-timed
src/integrations/headroom.ts NEW – optional proxy integration
```

### 3.2 Token counting — `src/context/tokens.ts`

`estimateTokens` (chars/3.6) drives every trigger. Make it calibrated per model:

```ts
export interface TokenCounter {
  /** Fast estimate for a string. */
  count(text: string): number;
  /** Feed back real usage: estimated tokens of the request vs provider-reported input. */
  calibrate(estimated: number, actual: number): void;
}
export function counterFor(model: Model): TokenCounter;
// OpenAI-family: gpt-tokenizer (MIT, pure JS, o200k) lazily loaded; others: chars/k with an
// EMA-calibrated k per provider/model persisted in ~/.rcode/cache/tokratio.json.
```

Hook: `compaction.ts` `estimateTokens` delegates to `counterFor(model)`. After each response,
`core/session.ts` calls `calibrate(sum(estimates), usage.input + cacheRead + cacheWrite)`. Tool results
are currently estimated only through the generic text branch, which is fine. Add a fixed overhead per
tool result block.

### 3.3 Artifact store — `src/context/artifacts.ts`

This replaces the ad-hoc `$TMPDIR/rcode-output` spill.

```ts
export interface Artifact { id: string; bytes: number; lines: number; kind: string; createdAt: number }
export interface ArtifactStore {
  put(content: string, kind: string): Artifact;          // id = sha256(content).slice(0,12)
  get(id: string): string | undefined;
  /** Text the model sees, e.g. `artifact://3f9a1c2b7d10 (12,408 lines, log)` */
  ref(a: Artifact): string;
}
// Location: ~/.rcode/sessions/<sessionId>/artifacts/<id>.txt  (survives resume; GC with session)
```

`read.ts` accepts `artifact://<id>` (plus offset, limit and the existing `:120-180` selector), and
`search.ts` can grep an artifact. This is CCR without a proxy: the model fetches originals with tools
it already knows. Content addressing makes repeated identical outputs free to store.

### 3.4 Tool-output shaping — `src/context/shape/`

```ts
export type OutputKind = "log" | "search" | "diff" | "json" | "text" | "code" | "auto";
export interface ShapeInput {
  text: string;
  tool: string;                 // "bash" | "grep" | mcp tool name …
  kind?: OutputKind;            // hint from the tool; "auto" → detect
  query?: string;               // last user prompt (relevance scoring for search/JSON)
  budget?: { lines: number; bytes: number };   // defaults MAX_LINES/MAX_BYTES
}
export interface ShapeResult {
  text: string;                 // what enters the transcript
  shaped: boolean;
  strategy: string;             // e.g. "log:pytest 4,210→96 lines", "json:table", "headtail"
  artifact?: Artifact;          // set whenever anything was dropped
  before: number; after: number; // estimated tokens
}
export function shapeOutput(i: ShapeInput, store: ArtifactStore): ShapeResult;
```

Pipeline, in order, each step fail-open and accepted only if it saves at least 10%:

1. `lossless.ts`: strip ANSI, collapse identical runs ("… repeated N times"), CRLF→LF, fold `\r`
   progress-bar overwrites (keep the final state). Always on; these are free wins on npm, cargo and
   pytest output.
2. Detect the kind with cheap regexes (no ML): unified diff headers; `path:line:` grep shape; JSON parse
   of the first non-space char `[`/`{`; log markers (`PASSED|FAILED|ERROR|WARN|Traceback|at .*:\d+`,
   cargo `error[E`, tsc `error TS`).
3. Kind-specific compressors, ported in spirit from headroom (Apache-2.0; keep NOTICE attribution if
   code is translated):
   - `log.ts`: classify lines; keep every ERROR/FAIL line with ±3 lines of context, complete stack
     traces, summary lines (`=== 1 failed, 499 passed`, `Tests: …`), the first 20 and last 40 lines,
     and deduped WARN. Marker: `[3,912 lines omitted: 3,880 PASSED/INFO, 32 WARN (deduped) — full:
     artifact://…]`.
   - `search.ts`: group by file; cap matches per file (e.g. 8) and files (e.g. 40); rank files by match
     count and query overlap; always keep the first match in each file. Emit `+N more in this file` and
     the artifact ref.
   - `diff.ts`: keep all `+`/`-` lines and trim context to 3; when over budget, keep all file headers and
     cap hunks per file (first, last, largest).
   - `json.ts`: (a) lossless re-encode of homogeneous arrays of objects as a header plus rows
     (`csv-schema`) when that saves ≥30%; (b) otherwise keep first 30% / last 15% / items containing
     error-ish keys or values / numeric outliers (>2σ), with a total cap. Never drop object keys.
   - `dense.ts`: headroom's elider heuristics (≥300-char lines, <6% spaces, ≥2000 dense chars per block).
   - `code`/`text`: **no lossy compression**. Fall back to head+tail.
4. Fallback **head + tail**, not tail-only. Keep the first 200 lines and the last ~1800 within budget.
   Tail-only loses the command banner and the first error. Codex and oh-my-pi both keep head and tail.

Hooks:

- `tools/util.ts`: `truncateTail(output, label)` becomes a thin wrapper over `shapeOutput` (keep the
  signature for existing callers). `bash.ts` passes `kind: "auto"`. `search.ts` passes
  `kind: "search"`. `web.ts` passes `kind: "text"` and runs HTML→text first if it doesn't already.
- MCP tool results (`src/mcp/manager.ts`) go through `shapeOutput(kind: "auto")`, which is where JSON
  arrays come from.
- Shaping always applies (not only above 50 KB) for kinds where it is lossless or near-lossless
  (`lossless`, `log` when ≥200 lines, `json` table re-encode). The lossy paths only trigger above a
  soft budget (default 8k tokens per result, configurable as `context.toolOutputTokens`), which is far
  below today's hard 50 KB ≈ 14k tokens.
- `details.shape = { strategy, before, after, artifact }` on the ToolResult. The TUI shows "⟜ shaped
  12.4k→1.1k" and `/context` aggregates the savings.

### 3.5 Cache-aware prompt layout — `src/context/cache.ts` + `system-prompt.ts`

Problems found in the current code:

1. `buildSystemPrompt` embeds **`date` and `git status` dirty count** (`system-prompt.ts:100-103`)
   and is rebuilt by `refreshTools()`, which runs on **every MCP `onChange`** (`session.ts:100`),
   mode switch and goal change. After any edit, the next rebuild changes the dirty count and busts
   tools + system + all messages.
2. MCP tools connect asynchronously (`void this.mcp.connectAll()`), so the tool list typically changes
   after the first turn: a guaranteed early full-cache rewrite.
3. One message breakpoint. A parallel batch of more than 20 results can push the previous breakpoint
   out of Anthropic's 20-block lookback.
4. Subagents (`createTaskTool` build) render a different system prompt per role, so nothing is shared
   between them. That is acceptable, but the static instructions block could be shared.

Design:

```ts
export interface PromptParts {
  static: string;     // instructions + tool guidance + skills index; cwd-independent where possible
  project: string;    // AGENTS.md/CLAUDE.md files + memory policy (changes rarely)
  volatile: string;   // date, git branch/dirty, active goal, mode – may change any time
}
export function buildPromptParts(o: SystemPromptOptions): PromptParts;

export interface CacheState {
  lastRequestAt: number;
  ttlMs: number;                 // 300_000 default; 3_600_000 when config.cache.longTtl
  isCold(now?: number): boolean; // now - lastRequestAt > ttlMs - 10s margin
  hitRatio: number;              // EMA of cacheRead / (input + cacheRead + cacheWrite)
}
```

- Anthropic `system` becomes `[{static, cache_control}, {project, cache_control}]`. **`volatile` is not
  in the system prompt at all.** It is a short `<env>` block prepended to the *user* message when the
  prompt is sent (`session.prompt`, next to `<relevant_memories>`), and only when it differs from the
  last value sent. The date and git status are then part of history (immutable) rather than of the
  prefix. The same applies to the active goal. For OpenAI/Gemini, use the same split with the volatile
  part in the user turn.
- **Tool stability**: sort tools deterministically (core tools in fixed order, then MCP tools sorted by
  `server/name`). Apply MCP tool-list changes **only at the next user prompt** (queue `refreshTools`
  while `agent.isRunning`), and on the first turn wait up to ~1.5 s for `connectAll` before the first
  request so the list starts complete. Strip schema annotations (`title`, `examples`, `$comment`,
  `default` descriptions) from MCP schemas in `toolSchema()`; it already deletes `$schema`.
- **Breakpoints** (Anthropic, max 4): system/static, system/project, the **previous** turn's last user
  block, and the **current** last user block. Drop the separate last-tool breakpoint, since tools
  precede the system prompt and are covered by the system breakpoint. This keeps reads hitting after
  big parallel batches.
- **TTL choice**: `config.cache.ttl: "5m" | "1h" | "auto"`. Auto switches to 1h for interactive TUI
  sessions where the user's think time often exceeds 5 minutes, measured as the median gap between
  prompts in this session above 4 minutes.
- **Observability**: record `cacheRead / cacheWrite / input` per turn (already in `Usage`). Show the
  cache hit percentage in the TUI status line. Warn once if hit percentage is under 50% after turn 5
  (a sign of a prefix-stability bug).
- **Output side**: the system prompt already says "be concise". Add a sentinel-terminated terse-mode
  paragraph to the *end* of `static`, toggled by `config.output.terse`. Do not change the effort level
  mid-session on Anthropic; it isn't a prefix change, but keep thinking behaviour predictable.

### 3.6 Epoch-based pruning — `src/context/prune.ts` (the `transformContext` hook)

```ts
export interface PruneSettings {
  enabled: boolean;               // default true
  protectRecentTokens: number;    // 40_000 – newest tool output never touched
  minSavingsTokens: number;       // 20_000 – don't open an epoch for less (warm cache)
  minResultTokens: number;        // 200 – never mask small results
  protectTools: string[];         // ["todo", "task"] + skill reads + plan file
}
export interface PruneDecision {        // persisted in session store, keyed by message id
  messageId: string; reason: "stale" | "superseded" | "masked" | "dedup" | "thinking";
  replacement: string;                  // exact bytes to send instead
}
export class Pruner {
  constructor(store: SessionStore, artifacts: ArtifactStore, cache: CacheState, s: PruneSettings);
  /** Pure function of (messages, persisted decisions); may open a new epoch. */
  transform(messages: Message[], ids: string[]): Message[];
}
```

Rules, in order of safety:

1. **Stale reads**: a `read` result for path P followed later by a successful `edit`/`write` to P
   (rcode already tracks reads in `ctx.state.get("reads")`; extend it with turn indices). Replacement:
   `[read of src/a.ts (412 lines) — superseded: file was edited afterwards. Re-read for current
   content.]`.
2. **Superseded reads**: the same path and overlapping range read again later; keep the latest.
3. **Superseded command output**: identical `bash` command strings (`bun test`, `git status`,
   `tsc --noEmit`) re-run later. Mask the earlier result to `[output of \`bun test\` — superseded by a
   later run; full: artifact://…]`.
4. **Observation masking**: tool results older than `protectRecentTokens` and larger than
   `minResultTokens` become `[<tool> <summary> → <N> lines elided; artifact://id]`. The summary is the
   tool's own `summarize(args)` (it exists on every tool) plus the first line of the result, and for
   errors the first error line.
5. **Cross-turn dedup** (P2): headroom's prefix-monotonic algorithm, run only inside an epoch.
6. **Thinking hygiene** (P1, model-gated): drop `thinking` blocks from assistant messages that precede
   the latest user prompt. **Never** touch the current tool loop's thinking, since Anthropic requires
   those blocks to be passed back during tool use.

Epoch policy (the cache-safety part):

- `transform` first replays **persisted decisions**, so the output bytes are identical to the last
  request and the cache still hits.
- It opens a **new epoch** (computes new decisions and persists them) only when
  (a) `cache.isCold()`, so the rewrite is free; or
  (b) projected savings ≥ `minSavingsTokens` **and** context is above 50% of the window; or
  (c) `shouldCompact` would otherwise fire. Pruning runs first, and summarization happens only if
  pruning can't get back under the threshold.
- Decisions never cover messages inside the last `protectRecentTokens`, and masked text always names a
  recovery path.

Hook in `core/session.ts` `agentHooks()`:

```ts
transformContext: (messages) => this.pruner.transform(messages, this.msgIds),
maybeCompact: async (messages, lastUsage) => {
  if (this.compacting) return;
  const t = contextTokens(this.pruner.transform(messages, this.msgIds), lastUsage);
  if (shouldCompact(this.model, t, this.compaction)) {
    if (this.pruner.forceEpoch(messages, this.msgIds) < limit) return;   // pruning was enough
    await this.compact();
  }
},
```

The session file keeps the full original messages. Pruning is a view, so `/fork`, resume and export
stay lossless.

### 3.7 Compaction changes — `src/session/compaction.ts`

- **Tiered**: prune (3.6) → summarize. The summary prompt is already good.
- **Cache-timed**: when the session is idle and `cache.isCold()` is near, prefer compacting at the next
  prompt rather than mid-loop. Mid-loop compaction is kept for overflow.
- **Render masked content** with the pruned view, so summaries don't re-ingest stale reads, and include
  artifact refs in "Critical Context" so the summary can point at originals.
- `keepRecentTokens` stays at 20k. Raise `triggerRatio` to 0.9 once pruning is on, because pruning
  absorbs most growth.

### 3.8 Repo map — `src/context/repomap/` + `src/tools/repomap.ts`

```ts
export interface RepoMapOptions {
  cwd: string;
  budgetTokens: number;          // default 1024 (tool) / 2048 when called with no focus
  focusFiles?: string[];         // personalization: files read/edited this session
  focusIdents?: string[];        // identifiers from the user prompt (camelCase/snake tokens)
  include?: string[]; exclude?: string[];  // globs; DEFAULT_IGNORES + .gitignore
}
export interface RepoMap { text: string; files: number; symbols: number; tokens: number; stale: boolean }
export function buildRepoMap(o: RepoMapOptions): Promise<RepoMap>;
```

- **Parsing**: `web-tree-sitter` (MIT, WASM, works in Bun) plus grammar WASMs for TS/JS/TSX, Python,
  Go, Rust, Java, C/C++, Ruby and C#, loaded lazily per language. Tags queries adapted from aider's and
  the grammars' `tags.scm` (MIT/Apache; keep attribution). Fallback: a regex outline for languages
  without a grammar.
- **Cache**: `~/.rcode/cache/tags/<repo-hash>.json`, keyed by path + mtime + size, updated
  incrementally. The first build of a 5k-file repo should take a few seconds, then milliseconds.
- **Ranking**: a graph of file → file edges weighted by referenced identifier (down-weight identifiers
  defined in more than 5 files and private `_x` names; up-weight focus identifiers ×10). Personalized
  PageRank with damping 0.85, about 30 iterations, using a hand-written sparse power iteration (no
  dependency). Distribute file rank to its definitions.
- **Rendering**: aider-style. The file path, then the signature lines of ranked definitions with `⋮`
  gaps. Binary-search the tag count to fit the budget, using `tokens.ts` for counting.
- **Surfaces**:
  1. A `repo_map` tool (read-only, shared concurrency) with args `{ focus?: string[], budget?: number }`.
     The system prompt says to call it first in an unfamiliar repo instead of serial `ls`/`grep`.
  2. **Optional injection** (`config.context.repoMap: "off" | "tool" | "inject"`, default `"tool"`).
     In inject mode, a map is placed in the *first user message* of a session (never in the system
     prompt, which would break prefix sharing across sessions) and refreshed only at compaction.
- **Read outline mode**: `read` gains `outline?: boolean`. A plain `read` of a file over 2000 lines
  without offset/limit returns **outline plus the first 200 lines** with a footer "use offset/limit or
  outline=false". It uses the same tree-sitter tags (signatures with line numbers, so the agent can jump
  with `path:120-180`). This replaces "truncate at 2000" with "show structure", à la repomix
  `--compress` but opt-out.

### 3.9 Optional headroom integration — `src/integrations/headroom.ts`

Headroom is not bundled. It is supported as an opt-in external through `baseUrl`:

```ts
export interface ContextProxyConfig {
  kind: "headroom";
  url: string;                 // default "http://127.0.0.1:8787"
  providers?: string[];        // default ["anthropic", "openai"]; never applied to OAuth tokens unless allowOAuth
  allowOAuth?: boolean;        // default false (subscription fingerprinting risk)
  spawn?: boolean;             // run `headroom proxy --port N` if healthy binary found; default false
}
export async function applyContextProxy(model: Model, cfg: ContextProxyConfig): Promise<Model>;
// - GET {url}/health (300 ms timeout); on failure: notice + fall back to direct baseUrl (fail-open).
// - anthropic-messages → baseUrl = url            (SDK appends /v1/messages)
// - openai-responses / openai-chat → baseUrl = `${url}/v1`
// - third-party OpenAI-compatible (deepseek, groq…): only if the proxy was started with
//   --openai-api-url pointing at that provider, else skip (headroom would forward to api.openai.com).
// - when spawning: env HEADROOM_BEACON=off, HEADROOM_TELEMETRY=off, DO_NOT_TRACK=1, --mode cache.
```

Hook: `ai/models.ts` model resolution, or `core/session.ts` `setModel` plus constructor, wraps the
resolved model. Config: `config.json → contextProxy`. `rcode doctor` reports proxy health and the
`/stats` savings.

Interplay rules:

- Keep rcode's native shaping on. It runs before headroom, and headroom's own router will skip
  already-small content. Native **pruning** stays on too, because headroom in `cache` mode never prunes
  history.
- With headroom's CCR on, the model may see `headroom_retrieve` markers. The proxy resolves those calls
  itself, so rcode needs nothing extra. Document `--no-ccr` for users who prefer rcode's
  `artifact://` refs.
- Also offer the **MCP route** in docs: `mcpServers: { headroom: { command: "headroom", args: ["mcp",
  "serve"] } }`, which gives `headroom_compress`/`headroom_retrieve` without proxying traffic.
- Don't reimplement Kompress. If users want ML prose compression, that is the headroom proxy's job.

### 3.10 Deferred / lazy MCP tools (P1)

When MCP tools total more than 40 or more than about 8k schema tokens, send only the names and
one-line descriptions plus a `tool_search(query)` meta-tool. Matched tools are activated on the next
turn by appending them in sorted order. That changes the tool prefix, so batch activations per user
prompt. On Anthropic, prefer the native tool-search / `defer_loading` feature where available.

### 3.11 Measuring it (do this first)

- A `/context` command that shows a breakdown: system / tools / history by role / tool results by tool,
  each with tokens, cache hit percentage for the last N turns, shaping savings, prune savings, and the
  artifact count.
- `bench/context/`: replay recorded sessions (session JSONL is already persisted) through
  shape + prune offline and report token deltas. Gate PRs on "no regression on fixtures where the
  answer-bearing line (FATAL/error/test name) must survive", the same discipline as headroom's
  `FATAL kept` checks.
- An end-to-end A/B on a small SWE-style task set (10-20 tasks), with pruning on and off, comparing
  solve rate, cost, and turns. Masking studies warn that summarization lengthens trajectories, so track
  turns, not just tokens.

---

## 4. Prioritized plan

### P0: cheap, high-leverage, low-risk (about 1-2 weeks)

1. **Cache-stable prompt layout** (3.5): move date, git status and goal out of the system prompt into a
   user-turn `<env>` block. Sort tools deterministically. Defer MCP tool changes to prompt boundaries
   and wait briefly for MCP on the first turn. Use two message breakpoints and drop the redundant tool
   breakpoint. Add cache hit percentage to the status line. *Likely the single largest cost win; no
   quality risk.*
2. **Artifact store + `artifact://` reads** (3.3): replace the tmpdir spill.
3. **Tool-output shaping v1** (3.4): lossless pass (ANSI, runs, progress bars), **head+tail** fallback,
   `log` and `search` compressors, soft per-result budget (8k tokens), shaping applied to MCP results.
4. **Stale/superseded read and command masking with persisted decisions** (3.6 rules 1-3) plus the
   epoch policy (cold-cache or ≥20k savings). Wire `transformContext`.
5. **`/context` breakdown** and calibrated token estimates (3.2, 3.11) so triggers stop drifting.

### P1: bigger wins, moderate effort (about 2-4 weeks)

1. **Repo map tool** (3.8) with web-tree-sitter, cached tags, personalized PageRank and a budget fit.
   Plus the `read` outline mode for large files.
2. **Observation masking** (3.6 rule 4) as tier 1 before LLM summarization. Raise `triggerRatio` to
   0.9. Cache-timed compaction (3.7).
3. **JSON and diff compressors** (headroom-style csv-schema table re-encoding; keep errors and outliers)
   and the dense-line elider.
4. **Thinking hygiene** for models that bill prior-turn thinking (verify billing per model first;
   headroom's numbers are reported, not mine).
5. **Optional headroom proxy integration** through `baseUrl` (3.9), with telemetry disabled when
   spawning and OAuth excluded by default. Plus a docs recipe for headroom MCP.
6. **Lazy MCP tool loading + schema compaction** (3.10).
7. **1h cache TTL "auto"** for interactive sessions; replay benchmark harness in `bench/context/`.

### P2: situational or research (later)

1. **Cross-turn verbatim dedup** (headroom's prefix-monotonic algorithm) inside prune epochs.
2. **LSP symbol tools** (Serena-like `find_symbol` / `references` / `replace_symbol_body`). Start by
   documenting Serena through MCP; go native only if usage data justifies it.
3. **Semantic code search** over tree-sitter chunks with ruvector as the index (opt-in, background
   index, Merkle/mtime sync). Measure against grep + repo map before making it default.
4. **Anthropic server-side context editing** (`clear_tool_uses`) as an alternative backend for users
   who want it. It overlaps with native pruning and is opaque to rcode's accounting.
5. **Prose compression** (LLMLingua-2/Kompress-class) only for `web` fetches and docs, through the
   headroom proxy, never on code.
6. **Learned importance** (TOIN-like): use retrieval of `artifact://` refs as feedback to shape less
   aggressively for tools whose outputs get re-fetched often.

### Licenses at a glance

| Source | License | How rcode should use it |
|---|---|---|
| headroom (code, docs) | Apache-2.0 | Port algorithms with attribution in NOTICE; don't vendor the Python. Kompress weights: check the HF model card before any use |
| aider repomap | Apache-2.0 | Reimplement in TS; keep attribution for adapted queries/logic |
| tree-sitter, web-tree-sitter, grammar repos | MIT (most grammars) | Direct dependencies (WASM) |
| repomix | MIT | Idea reference (`--compress` outline) |
| Serena | MIT | Use through MCP |
| SWE-agent, OpenHands condensers | MIT | Idea reference (masking) |
| LLMLingua / LongLLMLingua / LLMLingua-2 | MIT | Not embedded (model runtime); via headroom only |
| gpt-tokenizer / js-tiktoken | MIT | Optional dependency for OpenAI counting |
| oh-my-pi pruning/shake | see `docs/research/oh-my-pi.md` | Idea reference (cache-lookback-aware pruning, artifact refs) |
| context-mode | check the upstream license before reuse | Idea reference only (admission control at the tool boundary) |
