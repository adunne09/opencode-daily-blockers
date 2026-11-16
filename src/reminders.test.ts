import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localDate, nextMidnight, pending, Reminders } from "./reminders"

const roots: string[] = []
const stores: Reminders[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reminder-test-"))
  roots.push(root)
  const file = join(root, "reminders.sqlite")
  const store = new Reminders(file)
  stores.push(store)
  return { store, file }
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true }))
})

test("empty defaults; optional items do not gate; all required items do", () => {
  const { store } = fixture()
  expect(store.list()).toEqual([])
  store.add("Optional", false)
  const a = store.add("First", true)
  const b = store.add("Second", true)
  expect(pending(store.list())).toHaveLength(2)
  store.toggle(a)
  expect(pending(store.list())).toHaveLength(1)
  store.toggle(b)
  expect(pending(store.list())).toHaveLength(0)
  store.toggle(a)
  expect(pending(store.list())).toHaveLength(1)
})

test("completion persists and resets by calendar date, not elapsed time", () => {
  const { store, file } = fixture()
  const id = store.add("Synthetic task", true)
  const before = new Date(2026, 10, 14, 23, 59)
  const after = new Date(2026, 10, 15, 0, 1)
  store.toggle(id, before)
  const second = new Reminders(file)
  stores.push(second)
  expect(pending(second.list(), localDate(before))).toHaveLength(0)
  expect(pending(second.list(), localDate(after))).toHaveLength(1)
  expect(second.list()[0].completedOn).toBe(localDate(before))
})

test("multiple clients apply toggles to current state; deletion cannot resurrect", () => {
  const { store, file } = fixture()
  const second = new Reminders(file)
  stores.push(second)
  const id = store.add("Shared", true)
  store.toggle(id)
  second.toggle(id)
  expect(pending(store.list())).toHaveLength(1)
  second.edit(id, "Renamed", false)
  expect(store.list()[0].label).toBe("Renamed")
  expect(pending(store.list())).toHaveLength(0)
  store.remove(id)
  expect(second.toggle(id)).toBe(false)
  expect(second.edit(id, "Must not resurrect", true)).toBe(false)
  expect(second.list()).toEqual([])
})

test("sanitizes control characters and bounds labels", () => {
  const { store } = fixture()
  store.add("  line\nbreak\u001b\u202e ", false)
  expect(store.list()[0].label).toBe("line break")
  expect(() => store.add("\n ", true)).toThrow()
  expect(() => store.add("x".repeat(241), true)).toThrow()
})

test("concurrent process updates are serialized instead of losing toggles", async () => {
  const { store, file } = fixture()
  const id = store.add("Concurrent synthetic item", true)
  const children = [51, 50].map((count) => Bun.spawn([
    process.execPath, "-e",
    `import {Reminders} from ${JSON.stringify(join(import.meta.dir, "reminders.ts"))};
     const db = new Reminders(${JSON.stringify(file)});
     for (let i=0;i<${count};i++) db.toggle(${JSON.stringify(id)});
     db.close();`,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    // Bun's test runner defaults to UTC; standalone Bun uses the Mac's zone.
    env: { ...process.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone },
  }))
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0])
  expect(store.list()[0].completedOn).toBe(localDate())
  expect(pending(store.list())).toHaveLength(0)
})

test("corrupt database fails visibly and preserves the original bytes", () => {
  const { file } = fixture()
  const corrupt = file + ".corrupt"
  writeFileSync(corrupt, "invalid database")
  expect(() => new Reminders(corrupt)).toThrow()
  expect(readFileSync(corrupt, "utf8")).toBe("invalid database")
})

test("DST days use the next local midnight (test subprocess timezone only)", () => {
  for (const [month, day, hours] of [[2, 8, 23], [10, 1, 25]]) {
    const code = `import {nextMidnight} from ${JSON.stringify(join(import.meta.dir, "reminders.ts"))};
      const now = new Date(2026,${month},${day}); console.log((nextMidnight(now)-now.getTime())/3600000)`
    const child = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, TZ: "America/Denver" } })
    expect(child.exitCode).toBe(0)
    expect(Number(child.stdout.toString().trim())).toBe(hours)
  }
  expect(nextMidnight(new Date(2026, 10, 15, 23, 59))).toBe(new Date(2026, 10, 16).getTime())
})
