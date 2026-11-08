# Research: REA ("Reverse Engineer Anything") MCP

- Upstream: `morluto/rea` (MIT), npm `rea-agents` v6.8.0, MCP name `io.github.morluto/rea`
- Local clone studied: `/Users/rudycelekli/Downloads/rcode/reference/rea` (read-only; nothing built or executed)
- Purpose of this note: decide what rcode (TypeScript/Bun coding agent) should borrow as
  engineering patterns, and which reverse-engineering capabilities are worth exposing to a
  coding agent, and how.

All paths below are relative to the clone root unless absolute.

---

## 0. TL;DR

REA is a very large (~3,800 TS files, ~616k LOC including tests, ~3,200 test files) local-only
CLI + MCP server that exposes **246 audited tools** (plus a `discover_tools` meta-tool) over a
single "Evidence" result model. It is less an RE engine than an **orchestration and provenance
layer** over bring-your-own engines: Hopper, Ghidra (headless), IDA, Kuna, Rizin/Cutter, GNU
objdump, GDB/pwndbg, Frida, JADX/JEB/Apktool/adb, Chrome DevTools Protocol + Playwright, Wakaru,
WABT, tshark, binwalk/unblob, sigrok, plus many built-in pure-TS format parsers (ELF/PE/Mach-O
headers, Go/Rust build info, SQLite, WASM, IL2CPP, GGUF/safetensors, ASAR, source maps).

For rcode the most valuable takeaways are **not** the RE features themselves but the contract
machinery:

1. One canonical `ToolContract` per tool (Zod input + output schema, examples, declared effects)
   from which MCP annotations, docs, catalog digests and conformance tests are all derived.
2. A declared **effects audit** (`mutatesTarget`, `writesFilesystem`, `launchesProcess`,
   `accessesNetwork`, `executesForeignCode`, ...) that mechanically derives
   `readOnlyHint`/`destructiveHint`/`openWorldHint` — perfect input for a permission system.
3. A **`returnsTargetContent` / untrusted-content marker** on every result whose text originates
   from an analyzed artifact (prompt-injection defense, default-deny for unaudited tools).
4. **Progressive (hot/cold) tool catalog** with a `discover_tools` search tool that enables
   schemas on demand, capped at 20 per page.
5. **Byte-budgeted result delivery** that never silently truncates: overflow becomes a typed
   error carrying a machine-readable `continuation` (next tool call + smaller page).
6. **Retained Evidence + views**: large results are stored server-side with a content-addressed
   `evidence_id`; the model pages through them with `inspect_analysis_view` instead of re-running.
7. Typed `Result<T,E>` + tagged error algebra with `category`, `retryable`, `remediation.action`,
   and structured `recovery` kinds, published as a JSON Schema (`docs/error-contract.schema.json`).
8. Observed / derived / inferred confidence and explicit "unknown is not absence" semantics.

Capability-wise, a coding agent should consider an **optional plugin** offering a narrow,
static-first subset: JS bundle/source-map analysis, binary symbol/import/hardening inspection,
Go/Rust dependency provenance, SQLite/WASM inspection, and (opt-in) CDP/PTY observation of the
user's own app. Debugger/Frida/adb mutation tools should stay out of core.

---

## 1. Architecture

### 1.1 Layering

`AGENTS.md` mandates inward dependency flow: **domain -> contracts -> provider adapters ->
application workflows -> CLI/MCP adapters**. Diagram: `docs/architecture/architecture.mermaid`.

| Layer | Location | Role |
| --- | --- | --- |
| Domain | `src/domain/**` | Pure parsers and semantics (ELF/PE/Mach-O, evidence, errors, limits, views). No I/O. |
| Contracts | `src/contracts/**` | One `ToolContract` per public tool: Zod schemas, effects, examples, families. |
| Providers | `src/ghidra`, `src/hopper`, `src/ida`, `src/rizin`, `src/frida`, `src/browser`, `src/javascript`, `src/android`, ... | Engine protocols, process supervision, bridges. |
| Application | `src/application/**` | Provider-neutral services (`AnalysisProvider`, `EnhancedTools`, `CallPathTracing`, investigation ledger, setup/doctor/update). |
| Composition | `src/composition/**`, `src/main/**` | Wires services to providers, worker processes (`javascriptAnalysisWorkerProcess.ts`). |
| Adapters | `src/server/**` (MCP), `src/cli/**` + `src/cli.ts` (CLI) | Same workflows exposed both ways. |
| Process primitives | `src/process/**` | Owned commands, bounded output, PTY, process-identity/ownership, leases. |

The CLI and MCP surfaces share the same application services, so every MCP tool has a CLI twin
(e.g. `rea analyze-javascript-application <dir> --json`). This is how they run CI examples
(`examples/github-actions/rea-analysis.yml`).

### 1.2 MCP server structure

- SDK: `@modelcontextprotocol/server` / `client` **2.3.1**, Zod **4.6**, pino logging.
- Entry: `src/main.ts` -> `src/server/createServer.ts` (887 lines) builds an `EvidenceMcpServer`
  (`src/server/EvidenceMcpServer.ts`, core in `src/server/EvidenceMcpServerCore.ts`), wraps it in
  `RequestTrackingMcpServer` (cancellation / in-flight tracking) and optionally an HTTP transport
  (`src/server/http/`, `src/config/mcpHttpEndpoint.ts`).
- Registration is grouped per **tool family** via `registerToolFamilies` in
  `src/contracts/toolFamilyIds.ts`: a total map `{[Id in ToolFamilyId]: () => void}` so adding a
  family id is a compile error at every call site. `createServer.ts:368-809` calls
  `registerOfficialTools`, `registerEnhancedTools`, `registerNativeTools`, ... `registerSessionTools`.
- Families (18): `direct, enhanced, native, artifact, managed, firmware, android, pcap, flutter,
  frida, apktool, jeb, adb, browser, electron, javascript-runtime, application, session`.
  Operators narrow the advertised set with `REA_MCP_TOOL_FAMILIES` (`src/config/mcpToolFamilies.ts`).
- Server `instructions` are assembled per scope (`src/server/serverInstructions.ts`) and only
  mention tools that are actually advertised; they always append the untrusted-content warning.
- Prompts: `src/server/registerPrompts.ts`, `src/contracts/promptContracts.ts`.
- Catalog profiles: `REA_MCP_TOOL_CATALOG_PROFILE=full|hot-cold`, `REA_MCP_INPUT_SCHEMA_PROFILE=compact|full`
  (compact is default), `REA_MCP_OUTPUT_SCHEMA_PROFILE=full|compact|off`, `REA_MCP_MAX_RESPONSE_BYTES`
  (10 MiB floor). See `src/config/mcp*Profile.ts`, `src/config/mcpResponseBudget.ts`.

### 1.3 How a tool is defined, registered and validated

1. **Contract** — e.g. `src/contracts/sqlite/sqliteToolContracts.ts`:
   ```ts
   { name: "inspect_sqlite_database",
     ...toolContractMetadata("inspect_sqlite_database"), // title, effects, annotations, returnsTargetContent
     kind: "artifact-provider",
     description: "...",
     inputSchema: inspectSqliteDatabaseInputSchema,       // strict Zod
     outputSchema: evidenceResultOf(sqliteDatabaseSchema),
     examples: [{ title, input }] } as const satisfies readonly ToolContract[]
   ```
   Type: `src/contracts/toolContractTypes.ts`. All arrays are concatenated into the single
   ordered `TOOL_CONTRACTS` in `src/contracts/toolContracts.ts`; `toolContract(name)` is a
   type-level lookup that preserves exact schema types.
2. **Effects audit** — `src/contracts/toolEffects.ts` holds `TOOL_EFFECT_AUDIT`, an explicit
   record for every tool. `toolContractMetadata()` throws if a tool lacks an audit entry, so a new
   tool cannot ship without declaring effects. `annotationsFromEffects()` derives MCP hints
   with no name heuristics.
3. **Handler** — `src/server/contractToolHandler.ts`: `createEvidenceToolHandler(server, op, logger,
   recordEvidence, withAdmittedAnalysis)(contract)` produces the SDK callback. Shared pipeline:
   optional-provider availability -> admission (`analysisAdmission.ts`, `admittedToolOperation.ts`)
   -> logged execution with AbortSignal + MCP progress -> record Evidence into the session ledger
   -> deliver via `ToolResultDelivery`.
4. **Registration** — e.g. `src/server/registerSqliteTools.ts` calls
   `server.registerTool(contract.name, applicationToolRegistrationOptions(contract), handler(contract))`.
5. **Validation** — the SDK runs Zod validation; `EvidenceMcpServerCore.ts` wraps the schema's
   Standard Schema `validate` (`captureInputValidation`) to capture structured issues and turn them
   into an `AnalysisInputError` with `recovery.kind = "inspect_input_contract"`. Advertised JSON
   Schemas are re-validated against draft 2020-12 with Ajv at catalog generation time
   (`scripts/generate-mcp-tool-catalog.mjs`). Examples are validated by
   `src/contracts/advertisedInputExamples.test.ts`.
6. **Compact advertising** — `src/contracts/compactInputSchema.ts` / `compactJsonSchema.ts` reduce
   advertised schemas to a byte budget (strip annotations, shallow properties, inline refs for
   clients like Kimi that expand `$ref`), annotate them as reduced, and keep root guidance for
   context-bounding fields like `detail`. Server still validates the full canonical schema.

### 1.4 Tool catalog (246 tools, grouped)

Names extracted from `TOOL_EFFECT_AUDIT` in `src/contracts/toolEffects.ts`.

**Session, evidence and investigation (session family + meta)**
`open_binary, close_binary, binary_session, reset_investigation, open_bundle_resources,
get_evidence_bundle, export_evidence_bundle, import_evidence_bundle, get_navigation_context,
inspect_address_context, inspect_analysis_view, inspect_analysis_settings,
update_analysis_settings, list_unknowns, record_unknown, update_unknown,
verify_unknown_resolution, search_guidance, read_guidance_section, guided_workflows`
plus `discover_tools` (only in hot-cold profile; `src/catalogDiscovery.ts`).

**Native navigation, "direct" (Hopper-official-compatible names)**
`address_name, comment, inline_comment, current_address, current_procedure, current_document,
goto_address, next_address, prev_address, list_bookmarks, set_bookmark, unset_bookmark,
list_documents, list_names, list_procedures, list_segments, list_strings, procedure_address,
procedure_assembly, procedure_callees, procedure_callers, procedure_info, procedure_pseudo_code,
procedure_references, resolve_containing_procedure, search_procedures, search_strings,
set_address_name, set_addresses_names, set_comment, set_inline_comment, xrefs, read_bytes,
search_bytes, address_to_file_offset, read_function_instructions, inspect_native_instruction,
inspect_native_data_type, resolve_native_call_targets`

**Enhanced native workflows**
`binary_overview, analyze_function, batch_decompile, decompile_all, get_call_graph,
find_xrefs_to_name, trace_feature, trace_call_path, inspect_native_api, annotate_native_function,
get_objc_classes, get_objc_protocols, analyze_swift_types`

**Native provider / Apple / runtime-native**
`inspect_macho, inspect_signature, inspect_plist, list_architectures, demangle_swift,
trace_dylib_resolution, inspect_native_load_image, inspect_native_dispatch_metadata,
inspect_native_exports, observe_native_ui, capture_native_ui_scenario, observe_native_calls,
trace_native_ui_action, trace_native_values, match_native_functions, compare_functions`

**Static binary diagnostics (built-in parsers)**
`inspect_binary_layout, inspect_binary_hardening, inspect_byte_entropy, inspect_pe_imports,
inspect_pe_resources, inspect_pe_certificates, inspect_pe_load_config, inspect_elf_notes,
inspect_kernel_module, inspect_devicetree, inspect_apple_ips, inspect_recorded_crash`

**External RE tools (objdump / Rizin / Cutter / GDB)**
`inspect_with_objdump, execute_rizin_command, list_cutter_sessions, cutter_command,
start_gdb_session, gdb_console, gdb_session_status, close_gdb_session,
start_rizin_debug_session, rizin_debug_command, rizin_debug_session_status,
close_rizin_debug_session`

**Frida instrumentation**
`list_frida_devices, list_frida_processes, start_frida_session, load_frida_script,
resume_frida_session, unload_frida_script, frida_session_status, close_frida_session,
instrument_with_frida`

**Artifacts and formats**
`inspect_artifact, extract_artifact, compare_artifacts, inspect_desktop_application,
decode_interface_builder, inspect_asset_catalog, inspect_keyed_archive, inspect_go_binary,
inspect_rust_binary, inspect_il2cpp_metadata, inspect_model_artifact, inspect_gpu_code_objects,
inspect_python_pyc, inspect_erlang_beam, inspect_wasm_artifact, compare_wasm_interfaces,
inspect_evm_interface, inspect_apk_signature, inspect_sqlite_database, inspect_api_contract,
inspect_playwright_trace`

**Captures and signals**
`inspect_packet_capture, inspect_packet_fields, inspect_pcap_client, inspect_pcap_capture,
inspect_signal_decoders, decode_signal_recording`

**Firmware**: `inspect_firmware_regions` (binwalk), `extract_firmware` (unblob)

**Managed (.NET)**
`inspect_managed_artifact, inspect_managed_members, inspect_managed_native_boundaries,
compare_managed_members, verify_managed_native_boundaries, import_managed_reconstruction,
project_managed_application_graph`

**Android (static)**
`inspect_android_package, search_android_classes, inspect_android_class, inspect_android_method,
inspect_android_jni_bindings, trace_android_references, project_android_application_graph,
inspect_apktool_client, decode_android_resources, identify_flutter_build, inspect_dart_aot,
inspect_jeb_client, open_jeb_project, list_jeb_units, decompile_jeb_item`

**ADB device (24 tools)**
`inspect_adb_client, list_adb_devices, inspect_adb_device, list_adb_packages, inspect_adb_package,
resolve_adb_packages, pull_adb_package, pull_adb_file, push_adb_file, list_adb_directory,
read_adb_logcat, capture_adb_screen, list_adb_processes, list_adb_features, list_adb_services,
inspect_adb_display, inspect_adb_window, read_adb_setting, collect_adb_bugreport,
install_adb_package, uninstall_adb_package, start_adb_app, start_adb_activity, stop_adb_app`

**Browser / web (CDP + Playwright)**
`list_browser_targets, inspect_web_page, analyze_web_bundle, observe_web_session,
observe_web_execution, inspect_web_event_listeners, inspect_web_network_capture,
trace_web_source_location, trace_web_module_imports, export_web_scripts, discover_webmcp_tools,
capture_web_screenshot, compare_web_screenshots, compare_web_captures, capture_browser_scenario`

**Electron / JavaScript**
`list_electron_targets, inspect_electron_page, capture_electron_scenario, inspect_electron_fuses,
list_javascript_runtime_targets, observe_javascript_runtime, reconcile_javascript_runtime,
analyze_javascript_application, recover_javascript_sources, compare_source_to_bundle,
compare_javascript_export_shapes, trace_javascript_semantics`

**Application-level workflows, comparison, reconstruction**
`trace_application_feature, compare_application_versions, compare_static_and_observed_endpoints,
compare_bundles, find_changed_behavior, build_call_path, correlate_static_and_runtime,
verify_reconstruction, build_reconstruction_obligation_ledger, evaluate_reconstruction_coverage,
project_apple_application_graph, project_harmony_application_graph, capture_process_scenario,
compare_process_captures`

**Agent environments / desktop build computer (RL env export)**
`export_environment_bundle, start_build_computer, act_on_build_computer, start_build_capture,
mark_build_checkpoint, stop_build_capture, export_build_environment, check_build_task,
close_build_computer`

### 1.5 Native components and bridges

There is **no radare2** integration; Rizin (the r2 fork) and Cutter are used instead.

| Engine | Mechanism | Files |
| --- | --- | --- |
| Ghidra | Headless analyzer runs a packaged `HeadlessScript` (`ReaGhidraBridge`, 5.3k lines Java) that serves JSON-lines over a UNIX/TCP socket; ephemeral project, never modifies bytes, no GUI control. Extra scripts for DOS/DOL/raw/MIPS/RISC-V preparation. | `bridge/ghidra/*.java`, `src/ghidra/GhidraClient*.ts`, `GhidraLauncher.ts`, `GhidraCheckpoint.ts` |
| Hopper | Python bridge loaded inside Hopper, socket protocol, request queue; Linux uses a private X display. | `bridge/hopper_bridge.py`, `src/hopper/*` |
| IDA | Connects to IDA's MCP server / native protocol; read-only, never saves or closes the GUI DB. | `src/ida/IdaMcpConnection.ts`, `IdaNativeProtocol.ts` |
| Kuna | User-supplied `kuna` executable (static decompiler). | `src/kuna/`, `docs/kuna-provider.md` |
| Rizin / Cutter | CLI commands; Cutter via Python plugin bridge. | `src/rizin/`, `src/cutter/`, `bridge/cutter/rea_bridge.py` |
| objdump / GDB / pwndbg / pwntools | User-supplied CLIs; Python helper scripts. | `src/objdump/`, `src/gdb/`, `bridge/pwndbg/`, `bridge/pwntools/` |
| Frida | Optional npm dep `frida@17.23.2` (Node bindings), attach or spawn, script messages captured into bounded FIFOs. | `src/frida/FridaInstrumentationManager.ts`, `fridaCaptureLimits.ts` |
| Browser / Electron | `playwright-core` + raw CDP (`ws`), Chromium sandbox handling, source-map fetching. | `src/browser/Cdp*.ts`, `Playwright*.ts` |
| JS static | `@babel/parser` in an isolated worker process with heap limits; `@jridgewell/trace-mapping` for source maps; Wakaru for deobfuscation/unminify. | `src/javascript/analysis/`, `src/javascript/sourceMaps/`, `src/javascript/recovery/Wakaru*.ts`, `src/domain/javascript/` |
| Android | JADX via Java bridge, JEB via MCP, Apktool, adb CLIs. | `bridge/android/ReaJadxBridge.java`, `src/android`, `src/jeb`, `src/apktool`, `src/adb` |
| Network | mitmproxy addon, HAR/SAZ parsers, tshark. | `bridge/mitmproxy/capture.py`, `src/captures`, `src/pcap` |
| macOS native UI / tracing | Swift Accessibility helpers, LLDB Python tracer, Swift process-identity reader. | `bridge/native/*.swift`, `bridge/native/rea_lldb_tracer.py`, `bridge/process/*.swift` |
| Windows | One Node-API addon (C++) for filesystem/process/handle authority, SHA-256 + ABI checked before load, no env override. | `native/windows/src/*.cc`, `native/windows/README.md` |
| Process capture | `@lydell/node-pty` + `@xterm/headless` renderer for PTY sessions. | `src/process/`, `capture_process_scenario` |

All third-party engines are **bring-your-own**; installers must not install unrelated software
(`AGENTS.md`). `rea setup` shows planned changes and requires approval before writing configs.

---

## 2. Engineering patterns worth borrowing (any agent)

### 2.1 Tool contract design

- **Single source of truth.** Name, title, description, input/output Zod schemas, effects,
  annotations, untrusted flag and validated examples live together
  (`src/contracts/toolContractTypes.ts`). Registration, docs, catalog digests and tests derive
  from it. rcode should adopt an equivalent `ToolContract` type for native tools.
- **Exhaustive effect audit with fail-closed defaults** (`src/contracts/toolEffects.ts`):
  missing audit = throw at module load. Annotations are *derived*, never hand-written:
  - `readOnlyHint = !(any effect)`
  - `destructiveHint = mayDiscardData || executesForeignCode || mutatesDevice`
  - `openWorldHint = launchesProcess || accessesNetwork`
  For rcode this maps directly onto permission tiers (auto-allow read-only; prompt for
  `writesFilesystem`/`launchesProcess`; always prompt for `executesForeignCode`).
  Provider-dependent tools record both session effects and global possible effects
  (`providerEffects(session, global)`), so the advertised hint is the union across providers.
- **Untrusted target content** (`TARGET_CONTENT_FREE_TOOLS` allowlist in `toolEffects.ts`,
  `TARGET_CONTENT_RESULT_META` in `src/server/toolResultEncoding.ts`): every result that can carry
  artifact-originated text gets `_meta.provenance = { untrusted_content: true, source:
  "analysis_target" }`, and server instructions tell the model to treat it as data and report
  any embedded directive as injection. Unknown tool names default to untrusted. **rcode should do
  this for web fetch, file reads of third-party code, MCP results, and any decompiled output.**
- **Tool shapes** (`docs/development/tool-design.md`): `inspect`, `search/list`, `trace`,
  `compare`, `workflow`, `observe/capture` — task shapes, not prefixes; avoid multi-mode tools
  mixing discovery, execution and mutation.
- **Primitives first, workflows by demonstrated need.** Compose a workflow tool only when
  repeated use proves a multi-source outcome; no custom orchestration DSLs.
- **Preserve caller choices**: verbatim `caller_input_path`, no silent clamping ("dimensions are
  never clamped"), no automatic switching of target/provider in recovery.
- **Handlers bound to named contracts with exact types**; catalog ordering must never select an
  operation (`AGENTS.md`).

### 2.2 Schema validation

- Strict Zod objects everywhere (`z.strictObject`), discriminated unions for references.
- Validation issues captured from the SDK's own validation and projected into a typed
  `invalid_request` error with `recovery.kind = "inspect_input_contract"` only when the input
  contract is really at fault — a valid selector that resolves to nothing gets a different,
  actionable recovery (`tool-design.md` "Design recovery around the failure").
- Advertised schemas validated against draft 2020-12 (Ajv) after SDK conversion, and tested
  against real clients' quirks (Kimi `$ref` expansion, gateway-incompatible shapes in
  `compactJsonSchema.ts`).
- **Compact vs full advertised schema** with server-side canonical validation unchanged — a cheap
  way to cut tool-definition tokens without loosening validation.
- Input capacity budget: `DEFAULT_MCP_MAX_INPUT_ELEMENTS` (`src/config/mcpInputBudget.ts`) bounds
  structured input before parsing.

### 2.3 Result size, truncation and paging

- `ToolResultDelivery` (`src/server/ToolResultDelivery.ts`) encodes the full MCP envelope
  (structured + text duplicates) against `maximumResponseBytes - 1024`, measuring without
  allocating (`measureMcpResultWithinBudget`) and guarding Node's max string length.
- **Never silently truncate.** Overflow becomes `AnalysisResourceConstraintError` with
  `result_budget_bytes`, `response_bytes_at_least`, constraint type, and a `remediationAction`.
- **Continuations**: `src/server/toolResult.ts` builds a schema-validated
  `{ continuation: { name: "inspect_analysis_view", arguments: {...} } }`, halving the caller's
  page `limit` when the page itself overflowed. The model gets an exact next call.
- **Retained Evidence + views**: results are recorded in a session ledger
  (`src/application/investigation/EvidenceLedger.ts`); `inspect_analysis_view` accepts
  `{kind:"retained-evidence", evidence_id}`, inline evidence, or an evidence file, plus a typed
  view (`page`, `item`, `facet`, domain-specific views) — `src/domain/analysisView/analysisViewRequest.ts`.
  Tools accept `detail: "summary" | "complete"` (`createRetainedSummaryToolHandler`).
- `discover_tools` replies are also budget-checked and visibility only changes **after** the reply
  fits, so a failed page never silently enables tools.
- Explicit `next_offset: null` on exhaustion, `total` counts, and coverage fields
  (`relationship_coverage`, `discovery`) that distinguish "complete for what was examined" from
  "complete in reality".

rcode application: a generic `ResultStore` keyed by content digest for big tool outputs
(grep, test logs, build output), with a `read_result_page` tool and machine-readable
continuations instead of "...output truncated...".

### 2.4 Evidence and provenance

`src/domain/evidence.ts` defines a strict, content-addressed record:
`evidence_id` (prefixed SHA-256 of canonical JSON minus the id), `subject` (name, sha256, path,
format), `provider` (id/name/version), `analysis_profile`, `operation`, `parameters`,
`raw_result`, `normalized_result`, **`confidence: observed | derived | inferred`**,
**`authority: shipped-artifact | controlled-replay | historical-reference | external-service |
analyst-inference`**, `environment` (incl. isolation level), `limitations[]`,
`relationship_coverage`, `locations[]` (address / range / artifact-path / file-offset),
`evidence_links[]` (DAG of derivations). Bundles can be exported/imported and authenticated
(`computeEvidenceId` re-check), and residual **unknowns** are first-class records with revision
history (`record_unknown`, `update_unknown`, `verify_unknown_resolution`).

For rcode: a lighter "claim provenance" record for agent findings (source file + line range or
URL + digest, confidence tier, limitations) is a good fit for code review / research subagents,
and the "unknown is not absence" rule is a valuable instruction for any analysis tool.

### 2.5 Error algebra

- `src/domain/result.ts`: `Result<T,E> = {ok:true,value} | {ok:false,error}`; no throwing for
  expected failures.
- `src/domain/analysisError*.ts`: tagged errors (`AnalysisInputError`,
  `AnalysisResourceConstraintError`, `AnalysisCancelledError`, `AnalysisTimeoutError`,
  `AnalysisCapabilityUnavailableError`, `AnalysisAccessDeniedError`, `ProviderCleanupError`) that
  can carry **partial observations** and secondary failures (cleanup failed after success).
- Published schema `docs/error-contract.schema.json`: `code`, `category` (invalid_input,
  unsupported_provider, unsupported_target, integrity_mismatch, truncated, cancelled, timeout,
  resource_constraint, unavailable, execution_failure), `retryable`, `remediation.action`,
  `recovery` (`inspect_input_contract`, `inspect_timeout_state`, ...). User-visible errors are
  catalogued in `docs/user-visible-errors.csv`.
- Prerequisite failures distinguish missing executable, wrong path, wrong version, permission
  denied, and download timeout rather than "not installed".

### 2.6 Runtime settings with per-operation snapshots

`docs/design/limits-and-recovery.md`, `src/application/AnalysisSettings.ts`: curated limits are
named constants with units, optionally adjustable at runtime via `update_analysis_settings`.
Each handler captures an immutable settings revision in `AsyncLocalStorage`, so in-flight work
keeps its budget. Limit errors name the setting, its current value, floor/max, and whether a
restart is needed. Nice pattern for rcode's per-tool timeouts/output caps.

### 2.7 Process ownership and cleanup

`src/process/` (`OwnedCommand.ts`, `ProcessOwnership*.ts`, `BoundedOutputExcerpt.ts`,
`ExecFileBoundedOutput.ts`, `OwnedLease.ts`, `PersistentDebuggerHost.ts`): children are owned via
start identity (not just PID), output is bounded, cleanup failures retain ownership for retry,
cancellation during finalization is tested. External mutation commands
(`src/server/externalMutationAdmission.ts`) **retire the active analysis session** afterward so a
stale analysis cannot be reused while a background writer may still be running. Relevant to
rcode's background shell/PTY management.

### 2.8 Testing strategy

From `docs/development/testing.md` and configs:

- **Behavioral depths**: module (`src/**/*.test.ts`), composition (`tests/composition`), boundary
  (exactly one real boundary, `tests/boundary`, incl. `tests/boundary/mcp`), acceptance (compiled
  CLI/MCP journey, `tests/acceptance`), conformance (shared provider contracts parameterized by
  declared capabilities, `tests/conformance`), evaluation (`tests/evaluation`).
- Preference order: real public CLI/MCP workflow > production-boundary integration > goldens from
  real producers > module tests.
- **Boundary regression table** (format assumptions, raw identity, missing vs empty vs unknown,
  completed-then-failed work, independent limits, representation expansion, snapshot/cache
  invalidation, public success/error delivery) and **lifecycle regressions** (late handshakes,
  cancel during cleanup, cleanup retry).
- Anti-patterns banned: asserting prose substrings, `every` on empty arrays, optional chaining
  hiding missing facts, comparing two paths through the same algorithm. Recommends a controlled
  mutation of the relevant fact to prove a suspicious test fails.
- **Targeted mutation testing** with Stryker: `stryker.config.mjs` (vitest runner, perTest
  coverage) and `stryker.semantics.config.mjs` (command runner against a semantics-only vitest
  config `vitest.reverse-tools-semantics.config.ts`). Mutants are scoped to specific methods,
  guards, declarations and expressions via `scripts/lib/reverse-tools-mutation-targets.mjs`
  (`mutationRanges(file, [{kind:"guard", condition:"signal?.aborted"}, ...])`) rather than whole
  files — cheap and focused on cancellation/cleanup/timeout logic.
- Real-toolchain verification lanes as npm scripts (`verify:ghidra`, `verify:frida`,
  `verify:browser`, ... ~60 of them) kept separate from unit tests; "simulated providers do not
  establish real-provider behavior".
- MCP output-schema validation in tests always goes through the advertised `tools/list` definition
  (`artifactMcpCall` helper) so a fresh client can't skip validation.
- Custom vitest runner `tests/processOwnershipRunner.ts` checks no leaked child processes;
  `npm run verify:test-temp-hygiene` checks temp-dir hygiene.
- **Catalog cost evaluation with real agents** (`docs/mcp-catalog-evaluation.md`): measures actual
  model token usage for no-server vs full vs subset catalogs in Codex, with cgroup resource
  limits; explicitly warns that `tools/list` byte counts are not token counts.

### 2.9 Docs generation and drift control

- `scripts/generate-mcp-tool-catalog.mjs`: registers all contracts on an in-memory SDK server,
  reads back `tools/list`, Ajv-validates schemas, emits `.cache/mcp-tool-catalog.json` (test
  metadata) with `--check` mode.
- `scripts/record-catalog-digests.mjs`, `src/recordedCatalogDigests.ts`, `src/catalogIdentity.ts`:
  SHA-256 digests of tools/prompts catalog so catalog changes are visible and versioned.
- `scripts/generate-product-catalog.mjs`, `scripts/check-doc-facts.mjs`
  (`assertDocumentationFacts`): docs facts asserted against the product catalog;
  `<!-- BEGIN:... -->` generated regions in `docs/reference/mcp-contracts.md`.
- `scripts/generate-error-schema.mjs` (error contract), `generate-skill-metadata.mjs` /
  `verify-repository-skill.mjs` (packaged agent skill in `.agents/skills/reverse-engineer-anything/`),
  `verify-documentation-routes.mjs`.
- Specs/ADRs convention: `docs/specs/<domain>/<feature>/spec.md|plan.md|tasks.md`,
  `docs/adr/<domain>/<decision>.md`.

### 2.10 Agent-facing UX

- **Progressive tool catalog** (`src/server/ProgressiveToolCatalog.ts`, `src/catalogDiscovery.ts`):
  only 4 hot tools enabled (`binary_session, open_binary, close_binary, get_evidence_bundle`) plus
  `discover_tools`; search by keywords (all words must match name+description), page size default
  3, max 20; enabling a tool emits `tools/list_changed`; disabled-by-scope tools can never be
  re-enabled by discovery; reconnect resets to hot set. Fallback guidance for clients that don't
  refresh. Directly relevant to rcode's MCP client and its own deferred-tool loading.
- Performance priority order in `AGENTS.md`: **agent tokens/context first**, then analysis time,
  then CPU/memory; count the whole task including schemas, retries and extra calls.
- Packaged skill (`.agents/skills/reverse-engineer-anything/SKILL.md`) with explicit "skip REA for
  ordinary source-repository analysis" guidance, recovery rules (retry once only if safe to repeat).

---

## 3. Capabilities useful inside a coding agent

### 3.1 Legitimate, high-value use cases

| Use case in rcode | REA tool(s) | Mechanism | Risk |
| --- | --- | --- | --- |
| Understand a minified/compiled npm dependency, debug a stack trace in `dist/` | `analyze_javascript_application`, `trace_web_source_location`, `compare_source_to_bundle`, `compare_javascript_export_shapes`, `recover_javascript_sources` | Babel AST in worker, source-map decode, Wakaru unminify | Low (static); recovery writes files |
| Map a production bundle back to the user's source (source-map lookup) | `trace_web_source_location`, `src/javascript/sourceMaps/TraceSourceMap.ts` | trace-mapping | Low |
| Inspect a native addon / shared lib the project links (`.node`, `.so`, `.dylib`, `.dll`): exports, imports, hardening | `inspect_native_exports`, `inspect_pe_imports`, `inspect_elf_notes`, `inspect_macho`, `inspect_binary_hardening`, `list_architectures`, `demangle_swift` | Built-in parsers | Low |
| Dependency provenance of built Go/Rust binaries (SBOM-ish, CVE triage) | `inspect_go_binary`, `inspect_rust_binary` | Built-in parsers (buildinfo, cargo-auditable) | Low |
| Inspect app SQLite DB / WAL during debugging | `inspect_sqlite_database` | Copy + worker with limits, no arbitrary SQL | Low |
| Inspect WASM artifacts the project builds | `inspect_wasm_artifact`, `compare_wasm_interfaces` | WABT (BYO) | Low |
| Verify Electron security fuses / ASAR contents of user's own app | `inspect_electron_fuses`, `inspect_artifact`, `extract_artifact` | Built-in | Low/Med (extraction writes) |
| Compare two builds of the user's artifact (regression in bundle size/exports) | `compare_artifacts`, `compare_bundles`, `compare_application_versions` | Evidence diff | Low |
| Observe the user's running web app (scripts, network, listeners, screenshots) | `observe_web_session`, `inspect_web_page`, `observe_web_execution`, `capture_web_screenshot` | CDP/Playwright | Med (network, runs page JS) |
| Capture a CLI's terminal behavior and diff two runs | `capture_process_scenario`, `compare_process_captures` | PTY + xterm headless | Med/High (executes code, not sandboxed) |
| Analyze a crash dump of the user's binary | `inspect_apple_ips`, `inspect_recorded_crash` | Built-in / pwntools | Low |
| Disassemble/decompile a function of the user's own binary when no source (vendored blob) | `inspect_with_objdump`, `execute_rizin_command`, Ghidra-backed `analyze_function` | BYO engines | Med (rizin raw commands are unrestricted) |
| Inspect HAR captures to understand an API the app calls | `inspect_web_network_capture`, `inspect_api_contract` | Built-in | Low (may contain secrets) |

### 3.2 Not appropriate for rcode core

Frida spawn/attach/script injection, GDB/rizin debugger consoles, `cutter_command`, adb
install/uninstall/push/start, native UI driving, desktop build computer, RL environment export,
EVM, firmware extraction, IL2CPP/Unity, Android APK decompilation of third-party apps. These are
either high-authority (`executesForeignCode`, `mutatesDevice`) or oriented to third-party
software, and they belong in a dedicated tool the user opts into explicitly.

### 3.3 Integration options

**Option A — Optional MCP plugin (recommended first step).**
- Ship an rcode plugin manifest that registers `npx rea-agents` (or a pinned version) as an MCP
  server, disabled by default, enabled per project.
- Default env: `REA_MCP_TOOL_CATALOG_PROFILE=hot-cold`, `REA_MCP_INPUT_SCHEMA_PROFILE=compact`,
  `REA_MCP_TOOL_FAMILIES=artifact,native,javascript-runtime,application,session` (or narrower,
  excluding `frida`, `adb`, `jeb`, `apktool`, `direct` mutation tools).
- Map REA's MCP annotations onto rcode permissions: `readOnlyHint` -> auto-allow;
  `destructiveHint` (which covers `executesForeignCode`) -> always ask, never "always allow";
  `openWorldHint` -> ask in strict mode.
- Honor `_meta.provenance.untrusted_content` in rcode's MCP client: wrap such results in an
  untrusted-data envelope before they reach the model, and block any tool call the model
  proposes immediately afterward that matches commands found in the content (or at least flag).
- Pros: zero maintenance of RE engines, full catalog available, upstream keeps improving.
  Cons: Node >=22.23 runtime dependency (rcode is Bun; REA has `docs/bun-standalone.md` and
  `bunx` support but it's a separate process), large install, catalog churn, description strings
  are long (token cost) even in compact mode.

**Option B — Native rcode tools (small, curated, static only).**
Re-implement (or vendor, MIT) a handful of pure-TS capabilities that need no external engine:
1. `inspect_binary` — ELF/PE/Mach-O header, arch, exports/imports, hardening flags
   (port from `src/domain/elf*.ts`, `src/domain/native/`, PE import parsers).
2. `inspect_js_bundle` — module graph + source-map resolution for a `dist/` file
   (Babel parser is already a likely rcode dep; `@jridgewell/trace-mapping`).
3. `resolve_source_map` — map `file:line:col` in a bundle to original source.
4. `inspect_build_provenance` — Go buildinfo / Rust cargo-auditable.
5. `inspect_sqlite` — schema + bounded row sample, read-only, from a temp copy.
Each as an rcode `ToolContract` with declared effects (all read-only), byte budget, and
untrusted-content flag. Pros: Bun-native, small, no subprocess. Cons: maintenance; must reproduce
REA's careful bounds (decompression bombs, huge headers).

**Option C — Hybrid (recommended end state).** Native Option B tools for the 3-5 everyday static
cases; Option A plugin for deep native/web/runtime analysis when the user asks.

Either way, borrow the *patterns* from Section 2 into rcode's own tool layer regardless of
whether any RE capability ships.

---

## 4. Safety and disclaimer posture

### 4.1 What REA does

- `DISCLAIMER.md`: lawful uses (security research, malware/incident analysis, vuln research,
  CTF/education, interoperability, preservation, auditing software you own or are authorized to
  examine). Explicitly unsupported: DRM/license/anti-cheat bypass, game cheats, auth/bot-protection
  bypass, copying proprietary code/assets, evading AI provider policies, reselling AI access.
  Notes that authorization to inspect an artifact does not authorize execution, interception or
  device changes; that decompiled output grants no rights; that commercial tools must be licensed.
- `CONTRIBUTING.md` "Contribution scope" + **"Fail-closed integration"**: no purpose-built
  unpacking/devirtualization, anti-debug evasion, DRM/license bypass, exploit/payload automation,
  credential theft, persistence. Moving a capability to an optional plugin doesn't exempt it.
  Runtime capabilities (launch, attach, inject, mutate memory) require explicit maintainer scope
  decisions. Unresolved scope = do not merge.
- Technical controls: declared effects + derived destructive hints; untrusted-content marking and
  server instructions against prompt injection; Ghidra ephemeral/no byte mutation; IDA read-only;
  external mutation retires the analysis session; Frida resume only for processes it spawned;
  explicit sensitive-value redaction (`src/domain/explicitSensitiveFailure.ts`,
  `src/browser/BrowserScenarioSecrets.ts`); `capture_process_scenario` openly states "this is not
  a security sandbox"; `dry_run` mode for planned process scenarios.
- What it does **not** do: there is no hard opt-in gate for `executesForeignCode` tools beyond
  family selection and the client's approval of MCP annotations; raw Rizin/GDB/Cutter consoles are
  unrestricted by design.

### 4.2 Recommended rcode posture

1. **Scope statement**: RE features exist for *understanding and debugging software the user owns
   or is authorized to analyze* — their own builds, their dependencies (for interop, debugging,
   security review), their own running app. Ship a short `docs/` note modeled on REA's
   DISCLAIMER, not the full text.
2. **Default static-only.** Only effect-free/read-only tools enabled by default. Runtime
   observation (CDP, PTY capture) requires per-project opt-in; instrumentation/debugger/device
   families are never bundled in core.
3. **Target scoping**: default allowed targets are paths inside the workspace, `node_modules`,
   build output dirs, and localhost URLs; anything else prompts. Never auto-select a different
   target in recovery (REA's rule).
4. **Prompt-injection hygiene**: treat every artifact-derived string as untrusted; mark results;
   never execute commands suggested by analyzed content; surface them to the user.
5. **No bypass workflows**: rcode's system prompt/skill should decline DRM/license/anti-cheat
   circumvention and credential extraction regardless of tool availability, mirroring REA's list.
6. **Secrets**: HAR/SQLite/network/process captures can hold tokens — redact transport credentials
   in rendered output and keep raw captures local (REA preserves raw facts but redacts auth headers).
7. **Destructive = always ask**: map `executesForeignCode || mayDiscardData || mutatesDevice` to a
   non-persistable approval.

---

## 5. Strengths and weaknesses

### Strengths
- Exceptionally rigorous contract layer: exhaustive effects audit, derived annotations, untrusted
  marking with default-deny, typed errors with structured recovery.
- Context-efficiency engineering backed by real agent measurements (progressive catalog, compact
  schemas, retained evidence + views, continuations, `detail: summary`).
- Never-silently-truncate delivery; coverage semantics ("unknown is not absence").
- Content-addressed, authenticated Evidence with observed/derived/inferred and authority tiers.
- Same workflows via CLI and MCP; CI usage example.
- Serious process-ownership and cleanup discipline, cancellation tested through finalization.
- Testing doctrine (depth tiers, boundary/lifecycle regression catalogs, targeted Stryker mutation,
  real-toolchain lanes kept honest about what they prove).
- Generated, digest-checked catalog and docs facts; clear scope/fail-closed policy.
- BYO engines and no unrelated installs; config changes additive with backups.

### Weaknesses
- **Size and complexity**: ~616k LOC, 237 npm scripts, 246 tools, a 461 KB CHANGELOG; hard to vendor
  pieces without dragging in the evidence/ledger/admission machinery.
- **Very long tool descriptions** (e.g. `inspect_sqlite_database`, `capture_process_scenario`
  are paragraphs) — significant token cost in `full` catalog mode; prose-heavy, some abstract
  vocabulary ("admission", "authority", "owner") that models may misread.
- Node-only runtime with strict version floors (`^22.23.4 || ^24.22.1 || >=26.12.1`); not Bun-native.
- Heavy reliance on external engines whose availability varies by OS; many lanes Linux- or
  macOS-only; Windows Ghidra marked experimental.
- Runtime/debugger tools (rizin/gdb/cutter consoles, Frida scripts) are unrestricted when enabled;
  safety relies on client approvals and documentation.
- Evidence records are verbose (raw + normalized + metadata) — good for audit, heavy for context
  unless views are used diligently.
- Fast-moving: frequent breaking changes to snapshot identity (e.g. Kuna profile change invalidated
  snapshots; pre-6.6 evidence id commitments rejected).
- Some over-engineering for theoretical races (the repo itself warns contributors about this).

---

## 6. The 15 most important source files

| # | File | Why it matters |
| --- | --- | --- |
| 1 | `src/contracts/toolContractTypes.ts` | The `ToolContract` interface: schemas, effects, annotations, `returnsTargetContent`, examples. |
| 2 | `src/contracts/toolContracts.ts` | The single ordered `TOOL_CONTRACTS` inventory and typed `toolContract(name)` lookup. |
| 3 | `src/contracts/toolEffects.ts` | Exhaustive per-tool effects audit, annotation derivation, untrusted-content allowlist. |
| 4 | `src/contracts/toolFamilies.ts` / `toolFamilyIds.ts` | Family grouping, exhaustive registrar map, scope selection without loading schemas. |
| 5 | `src/server/createServer.ts` | Composition root: builds providers and registers every family. |
| 6 | `src/server/EvidenceMcpServerCore.ts` | SDK wrapper: validation capture, schema presentation, untrusted `_meta`, budget checks. |
| 7 | `src/server/contractToolHandler.ts` | Shared handler pipeline: admission, cancellation, progress, record, deliver. |
| 8 | `src/server/ToolResultDelivery.ts` | Byte-budgeted encoding, overflow projection, retained-evidence recovery. |
| 9 | `src/server/toolResult.ts` | Continuation construction (next call, halved page) for oversized results. |
| 10 | `src/server/ProgressiveToolCatalog.ts` + `src/catalogDiscovery.ts` | Hot/cold catalog and `discover_tools` search/enable. |
| 11 | `src/server/toolResultEncoding.ts` | `TARGET_CONTENT_RESULT_META`, untrusted-content instructions, envelope measurement. |
| 12 | `src/domain/evidence.ts` | Content-addressed Evidence schema (confidence, authority, locations, links, limitations). |
| 13 | `src/contracts/compactInputSchema.ts` | Budgeted compact advertised schemas with canonical server validation. |
| 14 | `src/frida/FridaInstrumentationManager.ts` | Representative high-authority provider: spawn/attach lifecycle, bounded capture, cleanup. |
| 15 | `bridge/ghidra/ReaGhidraBridge.java` | Representative engine bridge: headless Ghidra JSON-lines socket protocol, read-only ops. |

Honorable mentions: `src/server/externalMutationAdmission.ts` (retire session after unrestricted
commands), `src/domain/analysisView/analysisViewRequest.ts` (paging views over retained Evidence),
`src/application/AnalysisSettings.ts` (per-operation settings snapshots),
`scripts/generate-mcp-tool-catalog.mjs` (catalog generation + Ajv validation),
`stryker.config.mjs` + `scripts/lib/reverse-tools-mutation-targets.mjs` (targeted mutation),
`docs/development/tool-design.md` and `docs/development/testing.md` (design and test doctrine).

---

## 7. Concrete recommendations for rcode

1. Define `ToolContract<Name, In, Out>` in rcode core with required `effects` and
   `returnsUntrustedContent`; derive permission tier and MCP-style hints from effects; fail at
   startup if a tool lacks an audit entry.
2. Add a result budget + content-addressed result store + `continuation` field to every tool
   result; forbid silent truncation in tool implementations (lint/test).
3. Mark untrusted results (web fetch, MCP passthrough, third-party file reads, decompiler output)
   with a provenance flag and render them in an explicit untrusted-data envelope.
4. Implement deferred tool loading for MCP servers using REA's design: hot set + search tool,
   page cap, enable-after-fit, scope can't be widened by discovery.
5. Adopt the typed error contract (`category`, `retryable`, `remediation.action`,
   structured `recovery`) for tool failures so the model gets actionable next steps.
6. Adopt REA's test doctrine selectively: boundary + lifecycle regression checklists, targeted
   Stryker mutation on cancellation/cleanup guards, a child-process leak check in the test runner.
7. Ship RE as **Option C**: 3-5 static native tools (binary inspect, JS bundle + source map,
   build provenance, SQLite) plus an off-by-default REA MCP plugin preset restricted to static
   families; keep Frida/debugger/adb out of core and document the own-software scope.
