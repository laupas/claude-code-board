# agent-board

A Claude Code mod: a live board above the prompt that shows how much context is used and free, every agent and subagent with its own progress and current activity, and which files were changed, as a tree you can expand down to the changed lines.

```
╭───────────────────────────────────────────────────────────────────────────────────────────╮
│ ⠹ 2 running · 1 done  │  ctx ██░░░░░░░░ 15% 148k/1.0M  │  ✎ 3 files +58 −12  │  ⧗ cache 54m │
│ └ ⠹ Count 1 to 20  █████████░░░░░░░░░░░  9/20 45%  18s  Bash: count 9 of 20                 │
│ └ ✓ Review diff    ████████████████████  4/4 100%  1m55  finished                            │
╰───────────────────────────────────────────────────────────────────────────────────────────╯
```

## What it shows

- **Band above the prompt**: agents running and done, context fill, files changed, a countdown of the 1-hour prompt cache, session and last-turn cost, output speed (tok/s) and the prompt number. Pieces drop off as the window narrows. Under it, one line per subagent with its progress bar, elapsed time and what it is doing.
- **Agents panel** (`/board`, or the `details` button): the context split by category (as `/context` shows it), then the main loop and each subagent with a status badge, model, effort, estimated cost, progress bar, time, tool and model-call counts, context fill and current activity, grouped into Running and Finished. Opens by itself the first time a subagent starts.
- **Files changed**: a tree of the files the session and its subagents changed through Edit, Write and NotebookEdit, each with A (new) or M (modified), lines added and removed, a +/− bar, edits, who made them and when. Click a file (or Enter once focused) to show or hide its changed lines, edit by edit; `expand all` / `collapse all` at the top. Also on its own with `/board files`.
- **Progress**: the mod adds a `step` tool and one line to every subagent's brief asking it to report its plan (3 to 8 steps) and each finished step. When a tool call names a finer count ("count 7 of 20"), that is used instead.
- **Cache warning**: the band's frame turns amber 20 minutes before the prompt cache expires and red at 10, with a notification at 10 and 5 minutes (never while a turn runs).

The board starts from zero with each prompt you type; subagent hand-backs and notifications do not reset it.

## Install

In a Claude Code terminal session:

```
/plugin install agent-board --marketplace laupas/claude-code-board
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

Or load it from a clone for one session:

```bash
git clone https://github.com/laupas/claude-code-board.git
claude --plugin-dir ./claude-code-board
```

## Commands

| Command | Does |
| --- | --- |
| `/board` | open or close the agents panel |
| `/board files` | open or close the changed-files tree on its own |
| `/board hide`, `/board show` | hide or show the band above the prompt |

## Notes

- Built on Claude Code function hooks (`hooks/register.tsx`), an early-access API: tested on Claude Code 2.1.296, and it may change between releases.
- Costs are estimates from token counts and a per-model price table (`PRICES` in `hooks/register.tsx`, list prices as of 2026-10-10, taken from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit), MIT), not a bill.
- File changes made through Bash (`sed`, redirects, scripts) are found by comparing the working directory's files (size and modification time) before and after each Bash call: up to 20,000 entries, 8 levels deep, skipping `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `target` and `.next`. Lines are shown for a new file, and for a changed file whose earlier text the board saw; otherwise the change is listed without its lines. Deleted files and commands run in the background are not seen.
- Agents already running when the board loads (installed or reloaded mid-prompt) are put on the board right away.
- The `step` brief is appended to every subagent's prompt, which costs a few tokens per subagent.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
