---
name: git-hygiene
description: Safe, reviewable git practice - scoped commits, messages that explain why, branch and history safety, recovering from mistakes. Read before committing, rebasing, resolving conflicts, cleaning history, or running any destructive git command.
---

# Git hygiene

## Safety first

Destructive or outward commands need explicit user consent **every time**:
`git push` (any form), `push --force`/`--force-with-lease`, `reset --hard`, `clean -fd`, `checkout -- .`/`restore .` on uncommitted work, `branch -D`, `rebase` of pushed commits, `commit --amend` on pushed commits, `filter-repo`/`filter-branch`, `stash drop`/`clear`, tag deletion.

Before any risky operation:
- `git status` and `git stash list` to know what could be lost.
- Create a safety ref: `git branch backup/<name>-<date>` (cheap, local, reversible).
- Remember `git reflog` recovers most "lost" commits for ~90 days; uncommitted changes discarded by `reset --hard` or `checkout --` are **not** recoverable.

Never use `--no-verify` to skip hooks unless the user asks. If a hook fails, fix the cause.
Prefer `--force-with-lease` over `--force` when a force-push is approved.

## Scoping commits

- One logical change per commit: it should be revertable on its own and pass tests on its own.
- Separate refactors, formatting sweeps, dependency bumps, and behavior changes into different commits.
- Stage explicitly by path or hunk. Avoid `git add -A`/`git add .` unless you have just reviewed `git status` and every file belongs.
- Never commit: secrets or `.env` files, build output, `node_modules`/virtualenvs, large binaries (use LFS if the repo does), editor and OS files, debug leftovers (`console.log`, `debugger`, `.only`).

## Commit messages

```
<type>(<scope>): <imperative summary, ≤72 chars, no period>

<why this change is needed: the problem, the motivation>
<notable decisions or trade-offs; what was considered and rejected>
<anything a future git-blame reader needs>

Refs: #123
```
- Follow the repo's existing convention (check `git log --oneline -20`): Conventional Commits types (`feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`), ticket prefixes, or plain sentences.
- Subject says *what* at the level a reviewer cares about ("fix race in session refresh", not "update auth.ts").
- Body says *why*. The diff already shows what.
- Mark breaking changes with `!` after the type and a `BREAKING CHANGE:` footer describing the migration.
- Pass multi-line messages with a heredoc or `-F <file>`, not repeated `-m` hacks that mangle formatting.

## Branches

- Branch from an up-to-date base; name by intent (`fix/session-refresh-race`, `feat/export-csv`).
- Keep branches short-lived. Rebase or merge the base regularly, following the repo's policy (check for linear-history requirements in branch protection or CONTRIBUTING).
- Rebase only commits that are not shared. Once pushed and reviewed, prefer adding fixup commits; squash at merge time if the repo does.

## Conflicts

1. `git status` to list conflicted files; `git diff` to see both sides.
2. Understand both changes' intent (read the commits: `git log --merge -p <file>`) before choosing; the right resolution is often a combination.
3. Remove every marker (`<<<<<<<`, `=======`, `>>>>>>>`); grep to confirm.
4. Run tests before `git add` and continuing.
5. If lost: `git rebase --abort` / `git merge --abort` returns to the starting point.

## Useful read-only investigation

- `git log -S'<string>'` / `-G'<regex>'`: when a string was added or removed.
- `git log -p --follow -- <file>`: history across renames.
- `git blame -w -C <file>`: ignore whitespace, detect moved code.
- `git bisect start <bad> <good>; git bisect run <cmd>; git bisect reset`.
- `git diff <base>...HEAD`: changes on this branch only (three dots).
- `git range-diff`: compare two versions of a rebased branch.

## Recovering

| Situation | Recovery |
|---|---|
| Committed to the wrong branch (not pushed) | `git branch <new>`; `git reset --keep HEAD~1` on the wrong one (with consent) |
| Bad last commit message (not pushed) | `git commit --amend` (with consent) |
| Need to undo a pushed commit | `git revert <sha>` (new commit; history preserved) |
| Lost commit after reset/rebase | `git reflog`, then `git branch rescue <sha>` |
| Accidentally committed a secret | Treat it as leaked: rotate it first. History rewriting is secondary and needs consent. |

Adapted from agency-agents "Git Workflow Master" (MIT) and common git practice.
