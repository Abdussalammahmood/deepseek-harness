/**
 * Toolbox tab and control warning overlay for the Web client.
 *
 * The tab lists every MCP server (with its tools and per-tool switches), every
 * native tool grouped by the plugin that provides it (with a switch per
 * provider), and every installed skill. The overlay is a small always-visible
 * window that appears only while a machine-controlling capability is enabled.
 *
 * Both read and write the `toolbox` settings namespace owned by
 * `@deepseek-ai/dsh-toolbox`, whose host half applies the choices through the
 * same files the `mcp.ps1` CLI edits.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { useEffect, useRef, useState } from 'react'

/** One published MCP server, mirroring the host half's payload. */
export interface ToolboxServer {
  /** Manifest id. */
  id: string
  /** Human title. */
  title: string
  /** MCP namespace (`mcp__<serverName>__<tool>`). */
  serverName: string
  /** Free-text description. */
  description: string
  /** Whether the server is enabled. */
  enabled: boolean
  /** `control` when the server advertises machine-controlling tools. */
  risk: 'control' | 'normal'
  /** Every advertised tool. */
  tools: string[]
  /** The machine-controlling subset. */
  controlTools: string[]
  /** Tools the user switched off. */
  hiddenTools: string[]
}

/** One model-facing tool. */
export interface ToolboxTool {
  /** Model-visible name. */
  name: string
  /** Model-visible description. */
  description: string
}

/** Native tools grouped by the plugin that contributes them. */
export interface ToolboxToolGroup {
  /** Contributing package, or `(other)`. */
  plugin: string
  /** Loader entry id that the switch disables, absent when unidentified. */
  entryId?: string
  /** The tools this provider contributes. */
  tools: ToolboxTool[]
  /** Whether the provider is on. */
  enabled: boolean
}

/** One installed skill. */
export interface ToolboxSkill {
  /** Skill id. */
  name: string
  /** Routing description. */
  description: string
  /** Discovery source. */
  source: string
  /** Owning provider. */
  provider: string
  /** Whether model-facing catalogs currently include the skill. */
  modelInvocable: boolean
  /** Whether the harness can rewrite the skill's own frontmatter. */
  switchable: boolean
  /** Absolute path of the skill file, when known. */
  path?: string
}

/** The `toolbox` settings section. */
export interface ToolboxSettings {
  /** Published MCP servers. */
  servers: ToolboxServer[]
  /** Native tools grouped by provider. */
  toolGroups: ToolboxToolGroup[]
  /** Installed skills. */
  skills: ToolboxSkill[]
}

/** The slice of the settings scope this plugin uses. */
export interface ToolboxScope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: ToolboxSettings | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** Services this browser plugin needs. */
export const inject = ['slots', 'settingsScope']

const OVERLAY_KEY = 'dsh-toolbox-overlay-position-v1'
const OVERLAY_COLLAPSED_KEY = 'dsh-toolbox-overlay-collapsed-v1'

const C = {
  panel: '#0f1420',
  card: '#161c2b',
  border: '#26304a',
  text: '#e6e9f2',
  dim: '#98a2b8',
  warn: '#3a2a12',
  warnBorder: '#c9812a',
  warnText: '#ffcf8a',
  danger: '#e5533d',
  off: '#6b7280',
}

/** Subscribe a component to one settings scope. */
function useScope(scope: ToolboxScope): ReturnType<ToolboxScope['getSnapshot']> {
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => { setSnapshot(scope.getSnapshot()) }), [scope])
  return snapshot
}

/** The enabled servers that can control this machine. */
function dangerousServers(settings: ToolboxSettings | undefined): ToolboxServer[] {
  return (settings?.servers ?? []).filter(server => server.enabled && server.risk === 'control')
}

/** One server's tool list. */
function ToolList(props: {
  server: ToolboxServer
  writable: boolean
  onToggle: (tool: string, enabled: boolean) => void
}) {
  const { server, writable, onToggle } = props
  const hidden = new Set(server.hiddenTools)
  return (
    <div style={{ marginTop: 8, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
      {server.tools.map((tool) => {
        const isControl = server.controlTools.includes(tool)
        return (
          <label
            key={tool}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: writable ? 'pointer' : 'default' }}
          >
            <input
              type="checkbox"
              checked={!hidden.has(tool)}
              disabled={!writable || !server.enabled}
              onChange={(event) => { onToggle(tool, event.target.checked) }}
            />
            <span style={{ color: hidden.has(tool) ? C.off : C.text, fontSize: 13 }}>{tool}</span>
            {isControl && (
              <span style={{ color: C.danger, fontSize: 11, border: `1px solid ${C.danger}`, borderRadius: 4, padding: '0 4px' }}>
                controls PC
              </span>
            )}
          </label>
        )
      })}
    </div>
  )
}

/** Section shell. */
function Section(props: { title: string; note: string; count: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600 }}>
        {props.title}{' '}
        <span style={{ color: C.dim, fontWeight: 400, fontSize: 12 }}>{props.count}</span>
      </div>
      <div style={{ color: C.dim, fontSize: 12, margin: '2px 0 8px' }}>{props.note}</div>
      {props.children}
    </div>
  )
}

/** One native-tool provider with its switch. */
function ToolGroupCard(props: {
  group: ToolboxToolGroup
  writable: boolean
  open: boolean
  onToggleOpen: () => void
  onToggle: (enabled: boolean) => void
}) {
  const { group, writable, open, onToggleOpen, onToggle } = props
  const switchable = group.entryId !== undefined
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={group.enabled}
          disabled={!writable || !switchable}
          title={switchable ? `switch ${group.plugin} off` : 'this provider cannot be switched off individually'}
          onChange={(event) => { onToggle(event.target.checked) }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {group.plugin}{' '}
            <span style={{ color: C.dim, fontWeight: 400, fontSize: 11 }}>
              {group.tools.length} tool{group.tools.length === 1 ? '' : 's'}
              {switchable ? ` · entry ${group.entryId}` : ' · not switchable'}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleOpen}
          style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}
        >
          {open ? 'Hide' : 'Tools'}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
          {group.tools.map(tool => (
            <div key={tool.name} style={{ padding: '3px 0' }}>
              <div style={{ fontSize: 13, color: group.enabled ? C.text : C.off }}>{tool.name}</div>
              {tool.description !== '' && (
                <div style={{ color: C.dim, fontSize: 12 }}>{tool.description.slice(0, 200)}{tool.description.length > 200 ? '…' : ''}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The Toolbox tab body. */
export function ToolboxTab(props: { scope: ToolboxScope }) {
  const snapshot = useScope(props.scope)
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [openGroup, setOpenGroup] = useState<string | undefined>(undefined)

  const servers = snapshot.value?.servers ?? []
  const groups = snapshot.value?.toolGroups ?? []
  const skills = snapshot.value?.skills ?? []
  const writable = snapshot.writable
  const dangerous = dangerousServers(snapshot.value)
  const toolCount = groups.reduce((total, group) => total + group.tools.length, 0)

  const writeServers = (next: ToolboxServer[]): void => { void props.scope.set('servers', next) }
  const setEnabled = (id: string, enabled: boolean): void => {
    writeServers(servers.map(server => (server.id === id ? { ...server, enabled } : server)))
  }
  const setTool = (id: string, tool: string, enabled: boolean): void => {
    writeServers(servers.map((server) => {
      if (server.id !== id) return server
      const hidden = new Set(server.hiddenTools)
      if (enabled) hidden.delete(tool)
      else hidden.add(tool)
      return { ...server, hiddenTools: [...hidden] }
    }))
  }
  const setGroup = (entryId: string, enabled: boolean): void => {
    void props.scope.set('toolGroups', groups.map(group => (group.entryId === entryId ? { ...group, enabled } : group)))
  }
  const setSkill = (name: string, enabled: boolean): void => {
    void props.scope.set('skills', skills.map(skill => (skill.name === name ? { ...skill, modelInvocable: enabled } : skill)))
  }

  if (snapshot.status === 'loading') {
    return <div style={{ color: C.dim, fontSize: 13, padding: 12 }}>Loading toolbox…</div>
  }
  if (snapshot.status === 'unavailable') {
    return <div style={{ color: C.dim, fontSize: 13, padding: 12 }}>The toolbox namespace is not available in this session.</div>
  }

  return (
    <div style={{ background: C.panel, color: C.text, padding: 14, borderRadius: 8, fontSize: 14 }}>
      <strong>Toolbox</strong>
      <span style={{ color: C.dim, fontSize: 12, marginLeft: 10 }}>
        {servers.filter(server => server.enabled).length}/{servers.length} MCP servers ·{' '}
        {toolCount} native tools · {skills.length} skills
      </span>

      {dangerous.length > 0 && (
        <div style={{ marginTop: 10, background: C.warn, border: `1px solid ${C.warnBorder}`, color: C.warnText, borderRadius: 6, padding: '8px 10px', fontSize: 13 }}>
          <strong>Machine control is active.</strong>{' '}
          {dangerous.map(server => server.title).join(', ')}{' '}
          can move the mouse, type, take screenshots, and run commands on this computer while enabled.
        </div>
      )}

      <Section title="MCP servers" note="Each server's tools appear to the model as mcp__<name>__<tool>." count={`(${servers.length})`}>
        <div style={{ display: 'grid', gap: 10 }}>
          {servers.map(server => (
            <div key={server.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="checkbox"
                  checked={server.enabled}
                  disabled={!writable}
                  onChange={(event) => { setEnabled(server.id, event.target.checked) }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>
                    {server.title}{' '}
                    <span style={{ color: C.dim, fontWeight: 400, fontSize: 12 }}>mcp__{server.serverName}__*</span>
                    {server.risk === 'control' && (
                      <span style={{ color: C.danger, fontSize: 11, marginLeft: 8, border: `1px solid ${C.danger}`, borderRadius: 4, padding: '0 4px' }}>
                        controls PC
                      </span>
                    )}
                  </div>
                  {server.description !== '' && (
                    <div style={{ color: C.dim, fontSize: 12, marginTop: 2 }}>{server.description}</div>
                  )}
                </div>
                <span style={{ color: C.dim, fontSize: 12 }}>
                  {server.tools.length} tools{server.hiddenTools.length > 0 ? ` · ${server.hiddenTools.length} off` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => { setExpanded(expanded === server.id ? undefined : server.id) }}
                  style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}
                >
                  {expanded === server.id ? 'Hide tools' : 'Show tools'}
                </button>
              </div>
              {expanded === server.id && (
                <ToolList server={server} writable={writable} onToggle={(tool, enabled) => { setTool(server.id, tool, enabled) }} />
              )}
            </div>
          ))}
          {servers.length === 0 && <div style={{ color: C.dim, fontSize: 13 }}>No MCP servers found.</div>}
        </div>
      </Section>

      <Section
        title="Native tools"
        note="Built into the harness, grouped by the plugin that provides them. Switching a provider off disables that plugin's tool row and applies immediately."
        count={`(${toolCount})`}
      >
        <div style={{ display: 'grid', gap: 10 }}>
          {groups.map(group => (
            <ToolGroupCard
              key={group.plugin}
              group={group}
              writable={writable}
              open={openGroup === group.plugin}
              onToggleOpen={() => { setOpenGroup(openGroup === group.plugin ? undefined : group.plugin) }}
              onToggle={(enabled) => { if (group.entryId !== undefined) setGroup(group.entryId, enabled) }}
            />
          ))}
          {groups.length === 0 && <div style={{ color: C.dim, fontSize: 13 }}>No native tools reported.</div>}
        </div>
      </Section>

      <Section
        title="Skills"
        note="Installed skills. A filesystem skill switches by setting disable-model-invocation in its own file; bundled skills are read-only."
        count={`(${skills.length})`}
      >
        <div style={{ display: 'grid', gap: 6 }}>
          {skills.map(skill => (
            <div key={skill.name} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={skill.modelInvocable}
                  disabled={!writable || !skill.switchable}
                  title={skill.switchable ? 'include this skill in model catalogs' : 'bundled skill: read-only'}
                  onChange={(event) => { setSkill(skill.name, event.target.checked) }}
                />
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {skill.name}{' '}
                  <span style={{ color: C.dim, fontWeight: 400, fontSize: 11 }}>
                    {skill.source}{skill.provider !== '' ? ` · ${skill.provider}` : ''}{skill.switchable ? '' : ' · read-only'}
                  </span>
                </div>
              </div>
              {skill.description !== '' && (
                <div style={{ color: C.dim, fontSize: 12 }}>{skill.description}</div>
              )}
            </div>
          ))}
          {skills.length === 0 && <div style={{ color: C.dim, fontSize: 13 }}>No skills installed.</div>}
        </div>
      </Section>
    </div>
  )
}

/**
 * Always-visible control warning: a small floating window that appears only
 * while a machine-controlling capability is enabled.
 */
/**
 * Always-visible control warning, as a draggable heads-up display.
 *
 * It defaults to the TOP-right so it never covers the composer's send/stop
 * button, remembers wherever the user drags it, and collapses to a small pill.
 */
export function ControlOverlay(props: { scope: ToolboxScope }) {
  const snapshot = useScope(props.scope)
  const [pos, setPos] = useState<{ x: number; y: number } | undefined>(() => {
    try {
      const raw = window.localStorage.getItem(OVERLAY_KEY)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return { x: parsed.x, y: parsed.y }
      }
    } catch { /* an unreadable preference just means the default position */ }
    return undefined
  })
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem(OVERLAY_COLLAPSED_KEY) === '1' } catch { return false }
  })
  const drag = useRef<{ dx: number; dy: number } | undefined>(undefined)

  const dangerous = dangerousServers(snapshot.value)
  if (dangerous.length === 0) return null

  const persist = (next: { x: number; y: number } | undefined): void => {
    try { window.localStorage.setItem(OVERLAY_KEY, JSON.stringify(next)) } catch { /* preference is best-effort */ }
  }
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (rect === undefined) return
    drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current === undefined) return
    const x = Math.min(Math.max(0, event.clientX - drag.current.dx), window.innerWidth - 120)
    const y = Math.min(Math.max(0, event.clientY - drag.current.dy), window.innerHeight - 40)
    setPos({ x, y })
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current === undefined) return
    drag.current = undefined
    event.currentTarget.releasePointerCapture(event.pointerId)
    setPos((current) => { persist(current); return current })
  }
  const toggleCollapsed = (): void => {
    setCollapsed((was) => {
      const next = !was
      try { window.localStorage.setItem(OVERLAY_COLLAPSED_KEY, next ? '1' : '0') } catch { /* best-effort */ }
      return next
    })
  }

  const place = pos === undefined ? { right: 16, top: 64 } : { left: pos.x, top: pos.y }

  return (
    <div
      style={{
        position: 'fixed',
        ...place,
        zIndex: 2147483000,
        maxWidth: 320,
        background: C.warn,
        border: `1px solid ${C.warnBorder}`,
        color: C.warnText,
        borderRadius: 8,
        fontSize: 12,
        boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
        userSelect: 'none',
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'move', borderBottom: collapsed ? 'none' : `1px solid ${C.warnBorder}` }}
        title="drag to move"
      >
        <span style={{ fontWeight: 700 }}>⚠ Machine control is active</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'expand' : 'collapse'}
          style={{ background: 'transparent', border: `1px solid ${C.warnBorder}`, color: C.warnText, borderRadius: 4, cursor: 'pointer', fontSize: 11, lineHeight: '14px', padding: '0 5px' }}
        >
          {collapsed ? '+' : '–'}
        </button>
      </div>
      {!collapsed && (
        <div style={{ padding: '8px 10px' }}>
          {dangerous.map(server => (
            <div key={server.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ color: C.danger }}>●</span>
              <span>
                <strong>{server.title}</strong>
                {' — '}
                {server.controlTools.length} control tool{server.controlTools.length === 1 ? '' : 's'} enabled
              </span>
            </div>
          ))}
          <div style={{ marginTop: 6, opacity: 0.85 }}>
            Settings → Plugins → Toolbox to switch it off.
          </div>
        </div>
      )}
    </div>
  )
}

/** Contribute the Toolbox tab and the control warning overlay. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<ToolboxSettings>({ namespace: 'toolbox' }) as unknown as ToolboxScope

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'toolbox',
    order: 20,
    label: () => 'Toolbox',
    inject: () => ({ scope }),
  }, ToolboxTab))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'toolbox-control-warning',
    order: 50,
    inject: () => ({ scope }),
  }, ControlOverlay))
}
