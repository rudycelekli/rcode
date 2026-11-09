# Third-Party Notices

rcode's built-in content library (`builtin/commands`, `builtin/agents`, `builtin/skills`) was written for rcode. Parts of it adapt ideas, structure, checklists, and wording from the open-source projects below. No source code from these projects is included. Each project's copyright and license are given here as their licenses require.

Where a built-in file draws on a specific project, a credit line at the end of that file names it.

---

## agency-agents

- Repository: https://github.com/msitarzewski/agency-agents
- License: MIT
- Copyright (c) 2025 AgentLand Contributors
- Used in: `builtin/agents/*`: role definitions, critical rules, and output formats adapted from the engineering, testing, security, design, and research personas (including Code Reviewer, Codebase Onboarding Engineer, Minimal Change Engineer, Software Architect, Backend Architect, Application Security Engineer, Technical Writer, Performance Benchmarker, Database Optimizer, DevOps Automator, SRE, Frontend Developer, Accessibility Auditor, Data Engineer, Git Workflow Master). Also `builtin/skills/git-hygiene` and `security-checklist`.

## agentic-qe

- Repository: https://github.com/proffesor-for-testing/agentic-qe
- License: MIT
- Copyright (c) 2025 Agentic QE Contributors
- Used in: `/court` (qe-court protocol: defense, prosecution, blind refuters, jury, overturn round; SHIP/REMAND/BLOCK); the evidence rule with no findings quota and blind refuter subagents in `/review`, `/security`, `/court`, `/verify`; `/debug` (debug-loop); `/verify` (sherlock-review verdicts); `/qe` (risk-based testing, coverage-drop investigation, product factors); `/flaky`, `/refactor`, `/repair` (freeze-tests, no-skip, strict-tdd guard modes); `/testgen` and the `writing-tests` and `tdd-cycle` skills (test generation, mutation testing, test design techniques).

## ruflo

- Repository: https://github.com/ruvnet/ruflo
- License: MIT
- Copyright (c) 2024-2026 ruvnet
- Used in: plugins ruflo-ddd (`/ddd`, `ddd-modeling` skill), ruflo-adr (`/adr`, `adr-writing` skill and ADR template/lifecycle), ruflo-sparc (`/sparc` phases and gates), ruflo-testgen (`/tdd`, `/repair`, the observed-result contract, `tdd-cycle` skill), ruflo-security-audit (`/security`, honest-scanner language, `security-checklist` skill), ruflo-goals (`/plan`, `/goal`, `/research` run contract), ruflo-migrations (`/migrate` DB mode).

## oh-my-pi

- Repository: https://github.com/can1357/oh-my-pi
- License: MIT
- Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Used in: `builtin/agents/reviewer.md` (finding criteria, cross-boundary consumer check, P0-P3 priorities), `builtin/agents/explorer.md` (read-only scout pattern), and plan-mode conventions in `/plan`.

## open-ontologies

- Repository: https://github.com/fabio-rovai/open-ontologies
- License: MIT
- Copyright (c) 2026 Fabio Rovai
- Used in: `/ontology` (glossary-then-validate loop, competency questions); verdict words rather than booleans, "measured, not asserted" documentation honesty in `/docs`, `/release`, and `docs-writer`; blast-radius framing in `/impact`.

## colibri

- Repository: https://github.com/JustVugg/colibri
- License: Apache License, Version 2.0
- Copyright 2026 Vincenzo Fornaro
- NOTICE: colibri ships a `NOTICE` file. Following Section 4(d) of the Apache License 2.0, its attribution notice is reproduced here:
  ```
  colibri
  Copyright 2026 Vincenzo Fornaro

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
  ```
- Used in: the measurement principle ("an optimisation earns its place with a reproducible end-to-end measurement") adapted in `/perf` and `builtin/agents/performance-engineer.md`. No colibri source code or documentation text is redistributed.
- License text: https://www.apache.org/licenses/LICENSE-2.0

---

## agent-beacon

- Repository: https://github.com/Asymptote-Labs/agent-beacon
- License: MIT
- Used in: the local telemetry record's field names (`event.action`, `session.id`, `prompt.id`, `harness.name`, `gen_ai.tool.call.id`, `command.command`, `file.path`). rcode's threat rules are original; Beacon's rule corpus is not included.

## t3code

- Repository: https://github.com/pingdotgg/t3code
- License: MIT
- Copyright (c) T3 Tools Inc.
- Used in: `src/center/desk.ts`. The simctl and adb argument lists follow `apps/server/src/device/DeviceActions.ts`. The off-network link uses `cloudflared`, the same tunnel program T3 Connect runs. Their Effect code, relay account, and desktop application were not copied.

## rune

- Repository: https://github.com/anomalyco/rune
- License: MIT
- Copyright (c) Anomaly
- Used in: `src/modes/center.ts` and `src/center/skins.ts`. The default "Rune" skin and the command center layout follow Rune's design tokens (`site/src/system/tokens.css`: black canvas, hairlines, one red ink accent, 4 px grid, 8 px radius, 150 ms `cubic-bezier(.2,.8,.2,1)` enter) and its opencode demo layout. No Rust code or fonts were copied.

## MIT License (applies to the MIT-licensed projects above)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
