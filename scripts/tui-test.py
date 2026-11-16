"""Real installed-TUI integration, no credentials or model submissions.
Run: python3 scripts/tui-test.py
Leaves isolated data/captures for review; stops only its own tmux server.
"""
import json
import datetime
import os
from pathlib import Path
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
TEMP = Path(tempfile.gettempdir()) / "opencode"
TEMP.mkdir(exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix="reminders-tui-", dir=TEMP))
ART = Path(os.environ.get("REMINDERS_TEST_ARTIFACTS", REPO / "artifacts" / "tui"))
ART.mkdir(parents=True, exist_ok=True)
SOCKET = "reminders-verify-" + str(os.getpid())
BIN = os.environ.get("OPENCODE_BIN") or shutil.which("opencode")
if not BIN:
    raise RuntimeError("Install OpenCode or set OPENCODE_BIN to its executable.")
env = dict(HOME=str(ROOT / "home"), PATH=os.environ.get("PATH", os.defpath), TERM="xterm-256color")
for key, name in [("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache")]:
    env[key] = str(ROOT / name)
for name in ["home", "config", "data", "state", "cache", "work"]:
    (ROOT / name).mkdir()
env["OPENCODE_CLI_CONFIG_CONTENT"] = json.dumps({"plugins": [str(REPO)], "highlights": False})
command = "env -i " + " ".join(shlex.quote(k + "=" + v) for k, v in env.items()) + " " + shlex.quote(BIN) + " --standalone " + shlex.quote(str(ROOT / "work"))
DB = ROOT / "data/opencode-blocking-reminders/reminders.sqlite"
results = []

def tmux(*args):
    return subprocess.check_output(["tmux", "-L", SOCKET, *args], text=True)

def keys(*args):
    tmux("send-keys", "-t", "test", *args)
    time.sleep(.18)

def literal(text):
    tmux("send-keys", "-lt", "test", text)
    time.sleep(.18)

def raw(text):
    # One terminal write tests dispatch ordering, including Escape + text in a batch.
    subprocess.run(["tmux", "-L", SOCKET, "set-buffer", "--", text], check=True)
    tmux("paste-buffer", "-t", "test")
    time.sleep(.25)

def screen():
    return tmux("capture-pane", "-pt", "test")

def capture(name):
    value = screen()
    (ART / (name + ".txt")).write_text(value)
    return value

def check(name, assertion):
    if not assertion:
        capture("FAIL-" + name.replace(" ", "-"))
        raise AssertionError(name)
    results.append(name)
    print("PASS", name, flush=True)

def gate():
    return "complete blocking items" in screen().lower()

def rows():
    with sqlite3.connect(DB) as db:
        return db.execute("select label,blocking,completed_on from reminder order by created_at,id").fetchall()

def add(label, blocking=True):
    keys("a")
    literal(label)
    if not blocking:
        keys("Tab", "Space", "Tab")
    keys("Enter")

try:
    tmux("new-session", "-d", "-s", "test", "-x", "110", "-y", "34", command)
    for _ in range(100):
        if "Daily blockers 0/0" in screen():
            break
        time.sleep(.2)
    check("empty default unblocked", "Daily blockers 0/0" in capture("01-empty") and not gate())
    keys("C-g")
    check("manager opens", "DAILY BLOCKERS" in screen())
    add("Synthetic blocking one")
    check("first pending gates", gate())
    add("Synthetic blocking two")
    add("Synthetic optional", False)
    check("UI creates blocking and optional items", [r[1] for r in rows()] == [1, 1, 0])
    capture("02-wide-gate")
    keys("Escape", "Escape", "Escape", "C-c", "C-c")
    check("repeated Escape and CtrlC remain gated", gate())
    keys("C-p", "C-x", "l", "C-x", "n", "C-x", "b", "C-t", "C-1", "F2")
    check("palette leader session and tab bindings blocked", gate() and "Command palette" not in screen())
    raw("\x1b\x1bzzzz\x10\x18l")
    check("same batch escape and text stay gated", gate())
    check("host leader attempts do not change blocking flags", [r[1] for r in rows()] == [1, 1, 0])
    keys("Escape")
    check("editor cancel returns to gate", gate() and "Edit reminder" not in screen())
    raw("\x1b[200~PROMPT_PASTE_SENTINEL\x1b[201~")
    check("bracketed paste does not appear", "PROMPT_PASTE_SENTINEL" not in screen())
    # Pointer across root/sidebar/prompt: these are outside the centered reminder card.
    raw("\x1b[<0;2;2M\x1b[<0;2;2m\x1b[<0;109;18M\x1b[<0;109;18m\x1b[<2;2;2M\x1b[<2;2;2m")
    check("backdrop sidebar and right clicks remain gated", gate())
    capture("03-after-dismissal-attempts")
    tmux("resize-window", "-t", "test", "-x", "60", "-y", "24")
    time.sleep(.4)
    check("narrow gate", "Synthetic blocking one" in capture("04-narrow-gate"))
    literal("?")
    check("shortcut help is discoverable", "Blocking setting" in capture("04b-shortcuts"))
    keys("Escape")
    check("help escape returns to pending gate", gate() and "? Shortcuts" in screen())
    # Escape in add/edit returns to the pending base instead of unlocking.
    keys("a")
    check("add editor available while gated", "Add reminder" in screen() and "Text:" in screen())
    literal("Unsaved")
    keys("Escape")
    check("cancel add stays gated", gate() and len(rows()) == 3)
    keys("e")
    check("edit editor available while gated", "Edit reminder" in screen())
    capture("04c-editor")
    literal(" revised")
    keys("Enter")
    check("edit saved", rows()[0][0].endswith("revised"))
    keys("Space")
    check("one checkbox leaves gate", gate() and rows()[0][2] is not None and rows()[1][2] is None)
    keys("Tab", "Enter")
    check("all blocking complete unlocks with optional pending", not gate() and rows()[2][2] is None)
    literal("UNSENT_DRAFT_SENTINEL")
    view = capture("05-unlocked-draft")
    check("real prompt accepts draft no old key or paste leak", "UNSENT_DRAFT_SENTINEL" in view and "zzzz" not in view and "PROMPT_PASTE_SENTINEL" not in view)
    keys("C-g", "Up", "Space")
    check("uncheck regates", gate())
    keys("Space")
    check("recomplete unlocks", not gate())
    keys("C-g")
    add("Synthetic new blocking")
    check("new blocking regates", gate())
    tmux("respawn-pane", "-kt", "test")
    for _ in range(100):
        if gate():
            break
        time.sleep(.2)
    check("restart persists pending and completed", gate() and rows()[0][2] is not None and rows()[3][2] is None)
    capture("06-restart")
    # A separate client mutation to the isolated DB tests cross-client refresh.
    with sqlite3.connect(DB) as db:
        db.execute("update reminder set label='Externally edited synthetic' where label='Synthetic new blocking'")
    time.sleep(.7)
    check("multiple client change refresh", "Externally edited synthetic" in screen())
    # Date rollover integration: persisted yesterday completion is expired on focus.
    with sqlite3.connect(DB) as db:
        db.execute("update reminder set completed_on='2000-01-01'")
    raw("\x1b[I")
    time.sleep(.6)
    check("past date expires after focus", gate() and "0/4 complete" in screen())
    capture("07-date-refresh")
    # Delete action is explicit and cancellable, never a hidden dismissal.
    keys("d", "Escape")
    check("cancel delete preserves gate and data", gate() and len(rows()) == 4)
    keys("d", "y")
    check("confirmed delete persists", len(rows()) == 3 and gate())
    capture("08-management")
    # Click every pending blocking checkbox, then inspect a real session sidebar.
    for _ in range(2):
        view = screen().splitlines()
        index = next(i for i, line in enumerate(view) if "[ ]" in line and line.rstrip(" │").endswith("*"))
        column = view[index].index("[ ]") + 1
        raw(f"\x1b[<0;{column};{index + 1}M\x1b[<0;{column};{index + 1}m")
        if not gate():
            break
    check("mouse checkbox unlocks after last blocking item", not gate())
    tmux("resize-window", "-t", "test", "-x", "150", "-y", "38")
    fixture = ROOT / "fixture"
    fixture.mkdir()
    (fixture / "package.json").write_text(json.dumps({"name": "reminder-test-fixture", "type": "module", "exports": {"./tui": "./tui.ts"}}))
    (fixture / "tui.ts").write_text("""
import { Plugin } from "@opencode/plugin/tui"
export default Plugin.define({
  id: "reminder-test-fixture",
  async setup(context) {
    const session = await context.client.session.create({
      location: context.location ?? context.data.location.default(),
      title: "Synthetic reminder session",
    })
    await context.data.session.sync(session.id)
    context.ui.router.navigate({ type: "session", sessionID: session.id })
  },
})
""")
    session_env = {**env, "OPENCODE_CLI_CONFIG_CONTENT": json.dumps({"plugins": [str(REPO), str(fixture)], "highlights": False, "session": {"sidebar": "auto"}})}
    session_command = "env -i " + " ".join(shlex.quote(k + "=" + v) for k, v in session_env.items()) + " " + shlex.quote(BIN) + " --standalone " + shlex.quote(str(ROOT / "work"))
    tmux("respawn-pane", "-kt", "test", session_command)
    for _ in range(100):
        if "Manage / add" in screen():
            break
        time.sleep(.2)
    check("real session sidebar has reminder controls", "Manage / add" in capture("10-session-sidebar"))
    view = screen().splitlines()
    index = next(i for i, line in enumerate(view) if "[x]" in line and "Synthetic blocking two" in line)
    column = view[index].index("[x]") + 1
    raw(f"\x1b[<0;{column};{index + 1}M\x1b[<0;{column};{index + 1}m")
    check("sidebar uncheck regates session", gate())
    keys("C-p", "C-x", "l", "C-x", "n")
    raw("\x1b[<0;149;3M\x1b[<0;149;3m")
    check("session navigation and sidebar click cannot escape", gate())
    capture("11-session-gated")
    # Corruption is visible, preserved, and gated.
    with sqlite3.connect(DB) as db:
        db.execute("PRAGMA ignore_check_constraints=ON")
        db.execute("update reminder set completed_on='invalid'")
    time.sleep(.6)
    check("invalid data shown without reset", "Invalid reminder data" in capture("09-invalid-data") and len(rows()) == 3)
    # A private copy imports a fixture clock. Production has no clock override,
    # test RPC, completion endpoint, or date-bypass setting.
    clock_root = ROOT / "clock-profile"
    clock_plugin = ROOT / "clock-plugin"
    clock_plugin.mkdir()
    clock_env = {**env}
    clock_env["HOME"] = str(clock_root / "home")
    for key, name in [("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache")]:
        clock_env[key] = str(clock_root / name)
    for name in ["home", "config", "data", "state", "cache", "work"]:
        (clock_root / name).mkdir(parents=True)
    clock_file = clock_root / "now"
    clock_file.write_text(str(int(datetime.datetime(2026, 11, 16, 23, 59, 59, 700000).timestamp() * 1000)))
    (clock_plugin / "clock.js").write_text("""
import { readFileSync } from "node:fs"
const NativeDate = globalThis.Date
const now = () => Number(readFileSync(%s, "utf8"))
export class Date extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [now()])) }
  static now() { return now() }
}
""" % json.dumps(str(clock_file)))
    for name in ["tui.tsx", "reminders.ts"]:
        (clock_plugin / name).write_text('import { Date } from "./clock.js"\n' + (REPO / "src" / name).read_text())
    (clock_plugin / "package.json").write_text(json.dumps({"name": "reminder-clock-fixture", "type": "module", "exports": {"./tui": "./tui.tsx"}}))
    clock_env["OPENCODE_CLI_CONFIG_CONTENT"] = json.dumps({"plugins": [str(clock_plugin)], "highlights": False, "theme": {"mode": "light"}})
    clock_command = "env -i " + " ".join(shlex.quote(k + "=" + v) for k, v in clock_env.items()) + " " + shlex.quote(BIN) + " --standalone " + shlex.quote(str(clock_root / "work"))
    tmux("respawn-pane", "-kt", "test", clock_command)
    for _ in range(100):
        if "Daily blockers 0/0" in screen():
            break
        time.sleep(.2)
    keys("C-g")
    add("Synthetic midnight reminder")
    check("light theme gate paints", "2026-11-16" in capture("12-light-before-midnight") and gate())
    keys("Space")
    check("clock fixture manual completion unlocks", not gate())
    clock_file.write_text(str(int(datetime.datetime(2026, 11, 17, 0, 0, 0, 100000).timestamp() * 1000)))
    time.sleep(.8)
    check("local midnight automatically regates without input", gate() and "2026-11-17" in capture("13-midnight-reset"))
    for number in range(1, 13):
        clock_file.write_text(str(int(clock_file.read_text()) + 1000))
        label = f"Item {number:02d}"
        if number == 1:
            label += " — " + "A long synthetic label 界 " * 6
        add(label, False)
    tmux("resize-window", "-t", "test", "-x", "60", "-y", "24")
    time.sleep(.4)
    view = capture("16-long-list-top")
    check("long labels and list preserve narrow footer", "? Shortcuts" in view and "+ Add reminder" in view and "of 13" in view and "Item 01" in view)
    keys(*(["Down"] * 12))
    view = capture("17-long-list-scrolled")
    check("keyboard selection scrolls last reminder into view", "Item 12" in view and "› [ ]" in view and "? Shortcuts" in view)
    keys("Space")
    DB = clock_root / "data/opencode-blocking-reminders/reminders.sqlite"
    check("scrolled keyboard checkbox targets correct item", next(row for row in rows() if row[0] == "Item 12")[2] == "2026-11-17" and gate())
    view = screen().splitlines()
    index = next(i for i, line in enumerate(view) if "Item 10" in line)
    column = view[index].index("[ ]") + 1
    raw(f"\x1b[<0;{column};{index + 1}M\x1b[<0;{column};{index + 1}m")
    check("scrolled mouse checkbox targets correct item", next(row for row in rows() if row[0] == "Item 10")[2] == "2026-11-17" and next(row for row in rows() if row[0] == "Item 11")[2] is None)
    keys("e")
    capture("18-long-list-editor")
    keys("Escape")
    check("scrolled editor cancel preserves gate", gate() and "? Shortcuts" in screen())
    # Pointer-only entry and editor controls retain their larger hit targets.
    clock_file.write_text(str(int(clock_file.read_text()) + 1000))
    view = screen().splitlines()
    index = next(i for i, line in enumerate(view) if "+ Add reminder" in line)
    column = view[index].index("+ Add") + 1
    raw(f"\x1b[<0;{column};{index + 1}M\x1b[<0;{column};{index + 1}m")
    literal("Pointer-created synthetic")
    view = screen().splitlines()
    index = next(i for i, line in enumerate(view) if "[x] Blocking" in line)
    column = view[index].index("[x]") + 1
    raw(f"\x1b[<0;{column};{index + 1}M\x1b[<0;{column};{index + 1}m")
    view = screen().splitlines()
    index = next(i for i, line in enumerate(view) if "Save" in line and "Cancel" in line)
    column = view[index].index("Save") + 1
    raw(f"\x1b[<0;{column};{index + 1}M\x1b[<0;{column};{index + 1}m")
    check("mouse add blocking field and save work", any(row[0] == "Pointer-created synthetic" and row[1] == 0 for row in rows()) and gate())
    keys(*(["Up"] * 10), "Space")
    check("long list final blocker still unlocks", not gate())
    clock_env["OPENCODE_CLI_CONFIG_CONTENT"] = json.dumps({"plugins": [str(clock_plugin), str(fixture)], "highlights": False})
    sidebar_command = "env -i " + " ".join(shlex.quote(k + "=" + v) for k, v in clock_env.items()) + " " + shlex.quote(BIN) + " --standalone " + shlex.quote(str(clock_root / "work"))
    tmux("resize-window", "-t", "test", "-x", "150", "-y", "38")
    tmux("respawn-pane", "-kt", "test", sidebar_command)
    for _ in range(100):
        if "Manage / add" in screen():
            break
        time.sleep(.2)
    view = capture("19-bounded-sidebar")
    check("long sidebar stays bounded and truncates labels", "+10 more" in view and "Item 12" not in view and "Manage / add" in view)
    lines = view.splitlines()
    index = next(i for i, line in enumerate(lines) if "Manage / add" in line)
    column = lines[index].index("Manage / add") + 1
    raw(f"\x1b[<0;{column};{index + 1}M\x1b[<0;{column};{index + 1}m")
    check("sidebar manage click opens full list", "DAILY BLOCKERS" in screen() and "of 14" in screen())
finally:
    (ART / "integration-results.json").write_text(json.dumps({"profile": str(ROOT), "passed": results, "count": len(results)}, indent=2))
    subprocess.run(["tmux", "-L", SOCKET, "kill-server"], check=False)
    print("Profile:", ROOT)
