# OpenCode Daily Blockers

A quiet daily checklist for the OpenCode TUI. Finish what matters before jumping
back into work.

Blocking reminders cover the TUI until you check them off. Optional reminders
stay on the list without holding you up. Everything starts empty and stays local.

## Install

Requires **OpenCode 2.3.0**. Clone this repository:

```sh
git clone https://github.com/adunne09/opencode-daily-blockers.git
cd opencode-daily-blockers
```

Add the checkout's **absolute path** to the existing `plugins` array in
`~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/path/to/opencode-daily-blockers"]
}
```

Preserve your other settings and plugin entries. This is a TUI-only plugin;
it belongs in `cli.json`, not the server's `opencode.json`.
OpenCode supplies its runtime dependencies. No build or npm publication is
required. CLI configuration changes reload automatically.

## Use

Open **Daily blockers** with **Ctrl+G**, `/reminders`, or the command palette.
The sidebar shows a compact preview with checkboxes and **Manage / add**.

| Key | Action |
| --- | --- |
| ↑ / ↓ / Tab | Select a reminder |
| Space / Enter | Check or uncheck it for today |
| A | Add a reminder |
| E | Edit the selected reminder |
| B | Open its blocking setting |
| D | Delete, with confirmation |
| ? | Show all shortcuts |

In the editor, type a label, use **Tab** to move between fields, and use
**Space** on the blocking checkbox. **Enter** saves from the text field or
activates the selected control. **Escape** cancels.

Checkboxes, Add, editor controls, and Save/Cancel also work with the mouse.
Long lists keep the selected reminder visible. The sidebar previews four items
so it does not crowd the rest of your session.

## Daily behavior

- The last blocking completion closes the gate. Optional items may remain.
- Unchecking a blocking item or adding a new one brings the gate back.
- Escape, Ctrl+C, outside clicks, paste, and host navigation shortcuts cannot
  dismiss a pending gate or send input to the underlying prompt.
- Reminder configuration stays accessible. Canceling an editor returns to the
  pending gate; explicitly deleting a reminder or making it optional is allowed.
- Completions reset at local calendar midnight, including daylight-saving
  transitions. Focus/input checks also catch sleep or clock changes.
- Multiple TUI clients share atomic SQLite updates and refresh within 500 ms.

This is a personal TUI gate, not a security lock. Killing the client or removing
the plugin remains possible. Existing agents continue working; other OpenCode
interfaces and direct server APIs are unaffected.

## Local data

The database is stored at:

```text
$XDG_DATA_HOME/opencode-blocking-reminders/reminders.sqlite
```

If `XDG_DATA_HOME` is unset, it uses
`~/.local/share/opencode-blocking-reminders/reminders.sqlite`.
The original directory name is retained so existing reminders and completions
survive the project's rename. No migration or reset is needed.

Invalid data is reported visibly and preserved. Restore or repair the file and
press **R** to retry. No account, external notification service, or agent
completion tool is included.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:tui
```

The integration suite requires Python 3, tmux, and an installed OpenCode
executable. Set `OPENCODE_BIN` if it is not on `PATH`. It creates synthetic
reminders in isolated HOME/XDG directories and private standalone servers;
it never submits a model prompt.

Terminal captures and temporary fixture locations are written under the ignored
`artifacts/` directory. These are local diagnostics, not repository content.

The gate uses public OpenTUI Portal and ordered key/paste event APIs. It does
not patch OpenCode, enumerate host shortcuts, or intercept OS-wide input.
Compatibility is tested on the version above; another plugin deliberately
overriding input or overlay ownership is outside the guarantee.

## License

MIT
