import { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, RGBA, type KeyEvent, type PasteEvent } from "@opentui/core"
import { Portal, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { homedir } from "node:os"
import { join } from "node:path"
import { localDate, nextMidnight, pending, Reminders, type Reminder } from "./reminders"

export default Plugin.define({
  id: "blocking-reminders",
  setup(context) {
    const file = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode-blocking-reminders", "reminders.sqlite")
    const [items, setItems] = createSignal<Reminder[]>([])
    const [today, setToday] = createSignal(localDate())
    const [error, setError] = createSignal("")
    const [notice, setNotice] = createSignal("")
    const [opened, setOpened] = createSignal(false)
    const [selected, setSelected] = createSignal(0)
    const [editing, setEditing] = createSignal<{ id?: string; label: string; blocking: boolean }>()
    const [field, setField] = createSignal(0)
    const [deleting, setDeleting] = createSignal<string>()
    const [help, setHelp] = createSignal(false)
    const blocked = () => !!error() || pending(items(), today()).length > 0
    const visible = () => opened() || blocked() || !!editing() || !!deleting()
    let store: Reminders | undefined
    let lastSnapshot = ""
    let disposed = false

    function refresh() {
      if (disposed) return
      try {
        store ??= new Reminders(file)
        const next = store.list()
        const snapshot = JSON.stringify(next)
        if (snapshot !== lastSnapshot) {
          lastSnapshot = snapshot
          setItems(next)
        }
        setToday(localDate())
        setSelected((value) => Math.min(value, next.length))
        setError("")
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    function write(action: (data: Reminders) => void) {
      setNotice("")
      try {
        if (!store) throw new Error("Reminders store unavailable. Retry after repairing the data file.")
        action(store)
        refresh()
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    }
    function edit(item?: Reminder) {
      setNotice("")
      setEditing({ id: item?.id, label: item?.label ?? "", blocking: item?.blocking ?? true })
      setField(0)
    }
    function save() {
      const draft = editing()
      if (!draft) return
      write((data) => {
        if (draft.id) data.edit(draft.id, draft.label, draft.blocking)
        else data.add(draft.label, draft.blocking)
        setEditing(undefined)
        // Saving a pending item enters the gate; all-complete work returns to the prompt.
        setOpened(false)
      })
    }
    function toggle(index = selected()) {
      const item = items()[index]
      if (item) write((data) => {
        data.toggle(item.id)
        if (item.blocking) setOpened(false)
      })
    }
    function activate() {
      if (selected() === items().length) return edit()
      toggle()
    }
    function append(text: string) {
      setEditing((value) => value && {
        ...value,
        label: [...(value.label + text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "))].slice(0, 240).join(""),
      })
    }

    // Public OpenTUI EventEmitter API: run before host keymaps AND focused inputs.
    // No host renderable traversal, mutation, monkey patching, or reopen loop.
    function key(event: KeyEvent) {
      refresh()
      if (!visible()) return
      event.preventDefault()
      event.stopPropagation()
      if (event.eventType === "release") return
      const name = event.name
      if (deleting()) {
        if (name === "escape" || name === "n") setDeleting(undefined)
        if (name === "y") {
          write((data) => data.remove(deleting()!))
          setDeleting(undefined)
        }
        return
      }
      if (editing()) {
        if (name === "escape") return void setEditing(undefined)
        if (name === "tab") return void setField((value) => (value + (event.shift ? 3 : 1)) % 4)
        if (name === "return") {
          if (field() === 3) return void setEditing(undefined)
          if (field() === 1) return void setEditing((value) => value && { ...value, blocking: !value.blocking })
          return save()
        }
        if (field() === 1 && name === "space") return void setEditing((value) => value && { ...value, blocking: !value.blocking })
        if (field() !== 0) return
        if (name === "backspace" || name === "delete") {
          setEditing((value) => value && { ...value, label: [...value.label].slice(0, -1).join("") })
          return
        }
        if (event.ctrl || event.meta || event.super || event.hyper) return
        if (name === "space") return append(" ")
        if (event.sequence && !/[\p{Cc}]/u.test(event.sequence)) append(event.sequence)
        return
      }
      if (name === "escape") {
        if (help()) return void setHelp(false)
        if (!blocked()) setOpened(false)
        return
      }
      if (event.ctrl || event.meta || event.super || event.hyper) return
      if (event.sequence === "?") return void setHelp((value) => !value)
      if (help()) return
      if (name === "up" || (name === "tab" && event.shift)) {
        setSelected((value) => (value + items().length) % (items().length + 1))
        return
      }
      if (name === "down" || name === "tab") {
        setSelected((value) => (value + 1) % (items().length + 1))
        return
      }
      if (name === "return" || name === "space") return activate()
      if (name === "a") return edit()
      if (name === "r") return refresh()
      const item = items()[selected()]
      if (!item) return
      if (name === "e") return edit(item)
      if (name === "d") return void setDeleting(item.id)
      if (name === "b") {
        edit(item)
        setField(1)
      }
    }
    function paste(event: PasteEvent) {
      refresh()
      if (!visible()) return
      event.preventDefault()
      event.stopPropagation()
      if (editing() && field() === 0) append(new TextDecoder().decode(event.bytes))
    }
    refresh()
    context.renderer.keyInput.prependListener("keypress", key)
    context.renderer.keyInput.prependListener("keyrelease", key)
    context.renderer.keyInput.prependListener("paste", paste)
    context.renderer.on("focus", refresh)
    const poll = setInterval(refresh, 500)
    let midnight: ReturnType<typeof setTimeout>
    function schedule() {
      midnight = setTimeout(() => {
        refresh()
        schedule()
      }, Math.max(1, nextMidnight() - Date.now()))
    }
    schedule()
    context.keymap.layer(() => ({
      commands: [{
        id: "blocking-reminders.open", title: "Daily blockers", group: "Reminders",
        bind: "ctrl+g", palette: true, slash: { name: "reminders" },
        run: () => { refresh(); setOpened(true) },
      }],
    }))

    const theme = context.theme
    // The terminal-default background may be transparent; an exclusive overlay
    // must paint opaque cells so underlying text and hit targets are covered.
    const backdrop = () => RGBA.fromValues(theme.background.base.r, theme.background.base.g, theme.background.base.b, 1)
    const progress = () => `${items().filter((item) => item.completedOn === today()).length}/${items().length}`
    const removers = [
      context.ui.slot({
        append: "sidebar.content",
        render: () => (
          <box paddingTop={1} paddingBottom={1}>
            <box flexDirection="row" marginBottom={1}>
              <text fg={theme.text.base} flexGrow={1}>Daily blockers</text>
              <text fg={theme.text.muted}>{progress()}</text>
            </box>
            <For each={items().slice(0, 4)}>{(item) =>
              <box height={2} flexDirection="row" onMouseDown={(event) => {
                event.stopPropagation(); event.preventDefault()
                if (event.button === 0) write((data) => data.toggle(item.id))
              }}>
                <text width={4} fg={theme.text.formfield.base}>{item.completedOn === today() ? "[x]" : "[ ]"}</text>
                <text fg={item.completedOn === today() ? theme.text.muted : theme.text.base} flexGrow={1} flexShrink={1} minWidth={0} height={1} wrapMode="none" truncate>{item.label}</text>
                <text width={2} fg={theme.text.muted}>{item.blocking ? " *" : ""}</text>
              </box>
            }</For>
            <Show when={items().length > 4}><text fg={theme.text.muted}>+{items().length - 4} more</text></Show>
            <text marginTop={1} fg={theme.text.action.secondary.base} onMouseDown={(event) => {
              if (event.button === 0) setOpened(true)
            }}>Manage / add · Ctrl+G</text>
          </box>
        ),
      }),
      context.ui.slot({
        append: "home.footer",
        render: () => <text fg={theme.text.base} onMouseDown={() => setOpened(true)}>Daily blockers {progress()} · Ctrl+G</text>,
      }),
      context.ui.slot({
        append: "app",
        render() {
          const dimensions = useTerminalDimensions()
          const compact = () => dimensions().height < 22
          const rowHeight = () => compact() ? 1 : 2
          const rowCount = () => Math.max(1, Math.floor((dimensions().height - 16 - (error() || notice() ? 3 : 0)) / rowHeight()))
          const rowStart = () => Math.min(
            Math.max(0, items().length - rowCount()),
            Math.max(0, selected() - rowCount() + 1),
          )
          return (
            <Show when={visible()}>
              <Portal ref={(node) => {
                if (node instanceof BoxRenderable) {
                  node.zIndex = 10000
                  node.position = "absolute"
                  node.left = 0
                  node.top = 0
                }
              }}>
                <box position="absolute" left={0} top={0} width={dimensions().width} height={dimensions().height}
                  backgroundColor={backdrop()} alignItems="center" justifyContent="center"
                  onMouseDown={(event) => { event.preventDefault(); event.stopPropagation() }}
                  onMouseUp={(event) => { event.preventDefault(); event.stopPropagation() }}
                  onMouseScroll={(event) => { event.preventDefault(); event.stopPropagation() }}>
                  <box width={Math.min(82, Math.max(1, dimensions().width - 4))} border borderColor={theme.border.base}
                    paddingLeft={dimensions().width < 70 ? 2 : 3} paddingRight={dimensions().width < 70 ? 2 : 3}
                    paddingTop={1} paddingBottom={1} gap={1}>
                    <box>
                      <text fg={theme.text.base}><b>DAILY BLOCKERS</b></text>
                      <text fg={theme.text.muted}>{today()}   ·   {progress()} complete</text>
                      <Show when={blocked()}>
                        <text marginTop={compact() ? 0 : 1} fg={theme.text.muted}>Complete blocking items to continue</text>
                      </Show>
                    </box>
                    <Show when={error()}><text fg={theme.text.feedback.error.base} maxHeight={3}>Error: {error()} · R retry · data preserved</text></Show>
                    <Show when={notice()}><text fg={theme.text.feedback.error.base} maxHeight={3}>{notice()}</text></Show>
                    <Show when={editing()} fallback={
                      <Show when={deleting()} fallback={
                        <Show when={help()} fallback={
                          <box>
                            <Show when={items().length === 0}><text fg={theme.text.muted} marginBottom={1}>A little room for what matters. Add your first reminder.</text></Show>
                            <For each={items().slice(rowStart(), rowStart() + rowCount())}>{(item, index) =>
                              <box height={rowHeight()} flexDirection="row"
                                backgroundColor={selected() === rowStart() + index() ? theme.background.formfield.focused : undefined}
                                onMouseDown={(event) => {
                                  event.preventDefault(); event.stopPropagation()
                                  if (event.button !== 0) return
                                  setSelected(rowStart() + index())
                                  toggle()
                                }}>
                                <text width={6} fg={theme.text.formfield.state({ focused: selected() === rowStart() + index() })}>{`${selected() === rowStart() + index() ? "›" : " "} ${item.completedOn === today() ? "[x]" : "[ ]"}`}</text>
                                <text fg={item.completedOn === today() ? theme.text.muted : theme.text.base} flexGrow={1} flexShrink={1} minWidth={0} height={1} wrapMode="none" truncate>{item.label}</text>
                                <text width={2} fg={theme.text.muted}>{item.blocking ? " *" : ""}</text>
                              </box>
                            }</For>
                            <Show when={items().length > rowCount()}>
                              <text fg={theme.text.muted} height={1}>{rowStart() + 1}–{Math.min(items().length, rowStart() + rowCount())} of {items().length}   ·   ↑↓ more</text>
                            </Show>
                            <text marginTop={1} fg={theme.text.action.secondary.state({ focused: selected() === items().length })} onMouseDown={(event) => {
                              event.preventDefault(); event.stopPropagation()
                              if (event.button === 0) edit()
                            }}>{`${selected() === items().length ? "›" : " "} + Add reminder   A`}</text>
                            <box flexDirection="row" marginTop={1}>
                              <text fg={theme.text.muted} flexGrow={1}>Space check   ·   * blocking</text>
                              <text fg={theme.text.action.secondary.base} onMouseDown={(event) => {
                                if (event.button === 0) setHelp(true)
                              }}>? Shortcuts</text>
                            </box>
                            <Show when={!blocked()}><text marginTop={1} fg={theme.text.action.secondary.base} onMouseDown={(event) => {
                              if (event.button === 0) setOpened(false)
                            }}>Esc  Return to OpenCode</text></Show>
                          </box>
                        }>
                          <box gap={1}>
                            <text fg={theme.text.base}>Shortcuts</text>
                            <text fg={theme.text.muted}>↑↓ / Tab    Select a reminder{"\n"}Space / Enter    Check for today{"\n"}A    Add    ·    E    Edit{"\n"}B    Blocking setting    ·    D    Delete</text>
                            <text fg={theme.text.action.secondary.base} onMouseDown={(event) => {
                              if (event.button === 0) setHelp(false)
                            }}>? / Esc  Back to reminders</text>
                          </box>
                        </Show>
                      }>
                        <box gap={1}>
                          <text fg={theme.text.base}>Delete this reminder?</text>
                          <text fg={theme.text.muted} height={1} truncate>{items().find((item) => item.id === deleting())?.label}</text>
                          <text fg={theme.text.action.secondary.base}>Y confirm   ·   N / Esc cancel</text>
                        </box>
                      </Show>
                    }>
                      <box gap={1}>
                        <text fg={theme.text.base}>{editing()?.id ? "Edit reminder" : "Add reminder"}</text>
                        <box>
                          <text fg={theme.text.muted}>Text:</text>
                          <box paddingLeft={1} height={2} backgroundColor={theme.background.formfield.state({ focused: field() === 0 })}
                            onMouseDown={(event) => { if (event.button === 0) setField(0) }}>
                            <text fg={theme.text.formfield.state({ focused: field() === 0 })} height={1} wrapMode="none" truncate>{`${field() === 0 ? "› " : "  "}${(editing()?.label ?? "").slice(-Math.max(8, Math.min(82, dimensions().width - 4) - 12))}${field() === 0 ? "▏" : ""}`}</text>
                          </box>
                        </box>
                        <box height={2} onMouseDown={(event) => {
                          event.stopPropagation(); event.preventDefault()
                          if (event.button === 0) { setField(1); setEditing((value) => value && { ...value, blocking: !value.blocking }) }
                        }}>
                          <text fg={theme.text.formfield.state({ focused: field() === 1 })}>{`${field() === 1 ? "›" : " "} [${editing()?.blocking ? "x" : " "}] Blocking`}</text>
                          <text fg={theme.text.muted}>    Complete this before using OpenCode</text>
                        </box>
                        <box flexDirection="row" gap={3}>
                          <text width={12} fg={theme.text.action.primary.state({ focused: field() === 2 })} onMouseDown={(event) => { if (event.button === 0) save() }}>{`${field() === 2 ? "› " : "  "}Save`}</text>
                          <text width={12} fg={theme.text.action.secondary.state({ focused: field() === 3 })} onMouseDown={(event) => { if (event.button === 0) setEditing(undefined) }}>{`${field() === 3 ? "› " : "  "}Cancel`}</text>
                        </box>
                        <text fg={theme.text.muted}>Tab move   ·   Enter choose   ·   Esc cancel</text>
                      </box>
                    </Show>
                  </box>
                </box>
              </Portal>
            </Show>
          )
        },
      }),
    ]
    return () => {
      disposed = true
      clearInterval(poll)
      clearTimeout(midnight)
      context.renderer.keyInput.removeListener("keypress", key)
      context.renderer.keyInput.removeListener("keyrelease", key)
      context.renderer.keyInput.removeListener("paste", paste)
      context.renderer.removeListener("focus", refresh)
      removers.forEach((remove) => remove())
      store?.close()
    }
  },
})
