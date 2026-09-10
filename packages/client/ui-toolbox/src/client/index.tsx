/**
 * Toolbox tab for the Web Plugins settings section: every installed MCP server
 * with its tools, on/off switches for both, and a warning banner while a
 * machine-controlling server is enabled.
 *
 * Reads and writes the `toolbox` settings namespace owned by
 * `@deepseek-ai/dsh-toolbox`. The host half writes the same MCP toolbox
 * manifests, so this UI and the `mcp.ps1` CLI stay one source of truth.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
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

/** The `toolbox` settings section. */
export interface ToolboxSettings {
  /** Published servers. */
  servers: ToolboxServer[]
}

/** The slice of the settings scope this tab uses. */
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

const COLORS = {
  panel: '#0f1420',
  card: '#161c2b',
  border: '#26304a',
  text: '#e6e9f2',
  dim: '#98a2b8',
  warn: '#3a2a12',
  warnBorder: '#c9812a',
  warnText: '#ffcf8a',
  on: '#39d07f',
  off: '#6b7280',
  control: '#e5533d',
}

/** Render one server's tool list. */
function ToolList(props: {
  server: ToolboxServer
  writable: boolean
  onToggle: (tool: string, enabled: boolean) => void
}) {
  const { server, writable, onToggle } = props
  const hidden = new Set(server.hiddenTools)
  return (
    <div style={{ marginTop: 8, borderTop: `1px solid ${COLORS.border}`, paddingTop: 8 }}>
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
            <span style={{ color: hidden.has(tool) ? COLORS.off : COLORS.text, fontSize: 13 }}>{tool}</span>
            {isControl && (
              <span style={{ color: COLORS.control, fontSize: 11, border: `1px solid ${COLORS.control}`, borderRadius: 4, padding: '0 4px' }}>
                controls PC
              </span>
            )}
          </label>
        )
      })}
    </div>
  )
}

/** The Toolbox tab body. */
export function ToolboxTab(props: { scope: ToolboxScope }) {
  const [snapshot, setSnapshot] = useState(() => props.scope.getSnapshot())
  const [expanded, setExpanded] = useState<string | undefined>(undefined)

  useEffect(
    () => props.scope.subscribe(() => { setSnapshot(props.scope.getSnapshot()) }),
    [props.scope],
  )

  const servers = snapshot.value?.servers ?? []
  const writable = snapshot.writable
  const dangerous = servers.filter(server => server.enabled && server.risk === 'control')

  const write = (next: ToolboxServer[]): void => {
    void props.scope.set('servers', next)
  }
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
    return <div style={{ color: COLORS.dim, fontSize: 13, padding: 12 }}>Loading toolbox…</div>
  }
  if (snapshot.status === 'unavailable') {
    return <div style={{ color: COLORS.dim, fontSize: 13, padding: 12 }}>The toolbox namespace is not available in this session.</div>
  }

  return (
    <div style={{ background: COLORS.panel, color: COLORS.text, padding: 14, borderRadius: 8, fontSize: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <strong>Toolbox</strong>
        <span style={{ color: COLORS.dim, fontSize: 12 }}>
          {servers.length} MCP server{servers.length === 1 ? '' : 's'} ·{' '}
          {servers.filter(server => server.enabled).length} enabled
        </span>
      </div>

      {dangerous.length > 0 && (
        <div
          style={{
            marginTop: 10,
            background: COLORS.warn,
            border: `1px solid ${COLORS.warnBorder}`,
            color: COLORS.warnText,
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: 13,
          }}
        >
          <strong>Machine control is active.</strong>{' '}
          {dangerous.map(server => server.title).join(', ')}{' '}
          can move the mouse, type, take screenshots, and run commands on this computer while enabled.
        </div>
      )}

      <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
        {servers.map(server => (
          <div key={server.id} style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 10 }}>
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
                  <span style={{ color: COLORS.dim, fontWeight: 400, fontSize: 12 }}>mcp__{server.serverName}__*</span>
                </div>
                {server.description !== '' && (
                  <div style={{ color: COLORS.dim, fontSize: 12, marginTop: 2 }}>{server.description}</div>
                )}
              </div>
              <span style={{ color: COLORS.dim, fontSize: 12 }}>
                {server.tools.length} tools
                {server.hiddenTools.length > 0 ? ` · ${server.hiddenTools.length} off` : ''}
              </span>
              <button
                type="button"
                onClick={() => { setExpanded(expanded === server.id ? undefined : server.id) }}
                style={{
                  background: 'transparent',
                  border: `1px solid ${COLORS.border}`,
                  color: COLORS.text,
                  borderRadius: 4,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {expanded === server.id ? 'Hide tools' : 'Show tools'}
              </button>
            </div>
            {expanded === server.id && (
              <ToolList
                server={server}
                writable={writable}
                onToggle={(tool, enabled) => { setTool(server.id, tool, enabled) }}
              />
            )}
          </div>
        ))}
        {servers.length === 0 && (
          <div style={{ color: COLORS.dim, fontSize: 13 }}>
            No MCP servers found. Add a manifest to the toolbox folder and reload.
          </div>
        )}
      </div>
    </div>
  )
}

/** Contribute the Toolbox tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<ToolboxSettings>({ namespace: 'toolbox' }) as unknown as ToolboxScope
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'toolbox',
    order: 20,
    label: () => 'Toolbox',
    inject: () => ({ scope }),
  }, ToolboxTab))
}
