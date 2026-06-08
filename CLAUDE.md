# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile      # TypeScript → out/
npm run watch        # watch mode
npx @vscode/vsce package  # produce florian-vibe-*.vsix
```

Test in VS Code: open the folder, press **F5** → launches an Extension Development Host window.

## Architecture

The codebase is a single TypeScript file (`src/extension.ts`) plus four small supporting modules.

### Object model

**`FlorianVibe`** — singleton activated at extension startup. Owns the single `AcpClient` (one `vibe-acp` process for all sessions). Tracks the active text editor URI so each panel gets an up-to-date context file. Routes `session/update` ACP notifications to the right `ConversationPanel`.

**`ConversationPanel`** — one instance per editor tab. Wraps a `vscode.WebviewPanel`. Holds the session ID, mode, context state, and pending diff resolvers. Converts webview messages (user actions) into ACP requests, and ACP `session/update` events into webview `postMessage` calls.

**`AcpClient`** (`src/acp-client.ts`) — JSON-RPC 2.0 over stdio with `vibe-acp`. Handles requests from the server (`fs/read_text_file`, `fs/write_text_file`, `session/request_permission`) and sends requests to it (`initialize`, `session/new`, `session/load`, `chat/send`, etc.).

### Supporting modules

| File | Role |
|------|------|
| `src/diff-view.ts` | LCS-based line diff; `prepareDiff()` returns a ready-to-post payload + `writeIfAccepted()` callback |
| `src/permission.ts` | `askPermission()` — shows a VSCode warning message for ACP permission requests |
| `src/vision.ts` | Fallback image description via an external vision model (not yet wired — stub) |
| `scripts/patch-vibe-images.py` | Patches the `vibe-acp` binary to accept image blocks in ACP; **erased by `uv tool upgrade mistral-vibe`** |

### Webview HTML

`ConversationPanel.html()` returns a **single large template literal** containing all HTML, CSS, and inline JavaScript for the chat panel. This is the main UI surface. Key facts:

- All webview JS runs in Chromium, not Node — TypeScript types are not available.
- Use `var` (not `const`/`let`) in inline webview JS to avoid edge cases.
- **Never write `'\n'` in a JS string literal inside this template literal.** The template literal is evaluated at runtime, turning `\n` into a real newline character, which is a JS syntax error inside single-quoted strings in the webview. Use `'\\n'` to get a literal backslash-n.
- Same rule for any non-ASCII character in JS code or comments — Chromium's parser rejects them silently, crashing the script before the `ready` handshake, which leaves the panel stuck at "Connexion à vibe-acp…".

### Mode system

Modes come from the ACP `session/new` / `session/load` response. If the server sends none, `CLIENT_MODES` (Default / Auto Edit / Bypass) are used as fallback. In **bypass** mode, `session/request_permission` is auto-approved and `fs/write_text_file` skips the diff view.

### Slash commands and Vibe skills

Built-in slash commands (`/clear`, `/new`, `/mode`, `/context`, `/help`) are defined in `SLASH_COMMANDS` in the webview JS. Vibe skills are scanned at session start from:
- `~/.vibe/skills/<name>/SKILL.md` (user-level)
- `.vibe/skills/<name>/SKILL.md` (project-local)

Skills appear in the slash menu in blue and are invoked via `{ type: 'invokeSkill', skillName }` → the extension reads the SKILL.md body and calls `sendPrompt(body)`.

## Key gotchas

- **Image patch** — `vibe-acp` ships with `image=false` in its ACP capabilities. `scripts/patch-vibe-images.py` flips this. A `uv tool upgrade mistral-vibe` silently reverts it.
- **Session restore** — on panel reopen, the extension tries `session/load` with the stored session ID. If vibe-acp returns `SessionNotFoundError`, it transparently falls back to `session/new`.
- **Single ACP process** — all tabs share one `vibe-acp` process. If the process exits, all panels are cleared and reconnection happens on the next user action.
