/**
 * Toolbox tab and control warning overlay for the Web client.
 *
 * The tab lists every MCP server (with its tools and per-tool switches), every
 * native tool, and every installed skill. The overlay is a small always-visible
 * window that appears only while a machine-controlling capability is enabled.
 *
 * Both read and write the `toolbox` settings namespace owned by
 * `@deepseek-ai/dsh-toolbox`. The host half writes the same MCP toolbox
 * manifests, so this UI and the `mcp.ps1` CLI stay one source of truth.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { useEffect, useState } from 'react'

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

/** One native model-facing tool. */
export interface ToolboxTool {
  /** Model-visible name. */
  name: string
  /** Model-visible description. */
  description: string
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
}

/** The `toolbox` settings section. */
export interface ToolboxSettings {
  /** Published MCP servers. */
  servers: ToolboxServer[]
  /** Native tools. */
  nativeTools: ToolboxTool[]
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

/** The servers that are enabled and able to control this machine. */
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

/** The Toolbox tab body. */
export function ToolboxTab(props: { scope: ToolboxScope }) {
  const snapshot = useScope(props.scope)
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [showTools, setShowTools] = useState(false)

  const servers = snapshot.value?.servers ?? []
  const nativeTools = snapshot.value?.nativeTools ?? []
  const skills = snapshot.value?.skills ?? []
  const writable = snapshot.writable
  const dangerous = dangerousServers(snapshot.value)

  const write = (next: ToolboxServer[]): void => { void props.scope.set('servers', next) }
  const setEnabled = (id: string, enabled: boolean): void => {
    write(servers.map(server => (server.id === id ? { ...server, enabled } : server)))
  }
  const setTool = (id: string, tool: string, enabled: boolean): void => {
    write(servers.map((server) => {
      if (server.id !== id) return server
      const hidden = new Set(server.hiddenTools)
      if (enabled) hidden.delete(tool)
      else hidden.add(tool)
      return { ...server, hiddenTools: [...hidden] }
    }))
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
        {nativeTools.length} native tools · {skills.length} skills
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
        note="Built into the harness. Names and descriptions are read from the live tool registry."
        count={`(${nativeTools.length})`}
      >
        <button
          type="button"
          onClick={() => { setShowTools(!showTools) }}
          style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12 }}
        >
          {showTools ? 'Hide list' : 'Show list'}
        </button>
        {showTools && (
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {nativeTools.map(tool => (
              <div key={tool.name} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{tool.name}</div>
                {tool.description !== '' && (
                  <div style={{ color: C.dim, fontSize: 12 }}>{tool.description.slice(0, 220)}{tool.description.length > 220 ? '…' : ''}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Skills"
        note="Installed skills the model or the user can invoke."
        count={`(${skills.length})`}
      >
        <div style={{ display: 'grid', gap: 6 }}>
          {skills.map(skill => (
            <div key={skill.name} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {skill.name}{' '}
                <span style={{ color: C.dim, fontWeight: 400, fontSize: 11 }}>{skill.source}{skill.provider !== '' ? ` · ${skill.provider}` : ''}</span>
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
export function ControlOverlay(props: { scope: ToolboxScope }) {
  const snapshot = useScope(props.scope)
  const dangerous = dangerousServers(snapshot.value)
  if (dangerous.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 2147483000,
        maxWidth: 320,
        background: C.warn,
        border: `1px solid ${C.warnBorder}`,
        color: C.warnText,
        borderRadius: 8,
        padding: '10px 12px',
        fontSize: 12,
        boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ Machine control is active</div>
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
