import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

export type Reminder = {
  id: string
  label: string
  blocking: boolean
  completedOn: string | null
}

/** Calendar date on the machine running the TUI, not the connected server. */
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

/** Calendar arithmetic correctly handles 23/25-hour DST days. */
export function nextMidnight(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
}

export function pending(items: readonly Reminder[], today = localDate()) {
  return items.filter((item) => item.blocking && item.completedOn !== today)
}

function cleanLabel(label: string) {
  const text = label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim()
  if (!text || [...text].length > 240) throw new Error("Use a reminder between 1 and 240 characters.")
  return text
}

/**
 * SQLite serializes transactions between clients and never resets corrupt data.
 * Construction/read/write errors are surfaced by the TUI.
 */
export class Reminders {
  private db: Database

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new Database(file, { create: true, strict: true })
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
      if (version !== 0 && version !== 1) throw new Error(`Unsupported reminders schema ${version}.`)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS reminder (
          id TEXT PRIMARY KEY NOT NULL,
          label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 240),
          blocking INTEGER NOT NULL CHECK(blocking IN (0,1)),
          completed_on TEXT,
          created_at INTEGER NOT NULL
        ) STRICT;
        PRAGMA user_version=1;
      `)
      this.list()
    } catch (error) {
      this.db.close()
      throw new Error("Cannot read reminders. Keep the data file and restore a backup or repair it; it was not reset.", { cause: error })
    }
  }

  list(): Reminder[] {
    const rows = this.db.query<{ id: string; label: string; blocking: number; completed_on: string | null }, []>(
      "SELECT id,label,blocking,completed_on FROM reminder ORDER BY created_at,id",
    ).all()
    return rows.map((row) => {
      if (!/^[0-9a-f-]{36}$/i.test(row.id) || !row.label || row.label !== cleanLabel(row.label) ||
        (row.blocking !== 0 && row.blocking !== 1) ||
        (row.completed_on !== null && !/^\d{4}-\d{2}-\d{2}$/.test(row.completed_on))) {
        throw new Error("Invalid reminder data. The file has been preserved; repair or restore it.")
      }
      return { id: row.id, label: row.label, blocking: row.blocking === 1, completedOn: row.completed_on }
    })
  }

  add(label: string, blocking: boolean) {
    const id = randomUUID()
    this.db.query("INSERT INTO reminder VALUES (?,?,?,NULL,?)").run(id, cleanLabel(label), Number(blocking), Date.now())
    return id
  }

  edit(id: string, label: string, blocking: boolean) {
    return this.db.query("UPDATE reminder SET label=?,blocking=? WHERE id=?").run(cleanLabel(label), Number(blocking), id).changes > 0
  }

  remove(id: string) {
    return this.db.query("DELETE FROM reminder WHERE id=?").run(id).changes > 0
  }

  /** Call only from a user's checkbox action; no agent tool or RPC is exported. */
  toggle(id: string, now = new Date()) {
    const today = localDate(now)
    return this.db.query(`
      UPDATE reminder
      SET completed_on=CASE WHEN completed_on=? THEN NULL ELSE ? END
      WHERE id=?
    `).run(today, today, id).changes > 0
  }

  close() {
    this.db.close()
  }
}
