/**
 * Cloud Sync tab for the Web client.
 *
 * Reads and writes the `cloud-sync` settings namespace owned by
 * `@deepseek-ai/dsh-cloud-sync`, whose host half mirrors the DeepSeek Harness
 * home into a local OneDrive/Google Drive folder. The cloud app's own desktop
 * client performs the authenticated upload, so this tab only configures the
 * local mirror.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { useEffect, useState } from 'react'

/** The `cloud-sync` settings section. */
export interface CloudSyncSettings {
  enabled: boolean
  provider: 'onedrive' | 'google-drive' | 'custom'
  target: string
  intervalMinutes: number
  restoreOnStartup: boolean
  syncRequest: number
  lastSyncAt: string
  lastSyncStatus: string
  lastSyncFiles: number
}

/** The slice of the settings scope this plugin uses. */
export interface CloudSyncScope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: CloudSyncSettings | undefined
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
  ok: '#3aa675',
  off: '#6b7280',
}

/** Subscribe a component to one settings scope. */
function useScope(scope: CloudSyncScope): ReturnType<CloudSyncScope['getSnapshot']> {
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => { setSnapshot(scope.getSnapshot()) }), [scope])
  return snapshot
}

function Row(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{props.label}</div>
        {props.hint !== undefined && <div style={{ color: C.dim, fontSize: 12, marginTop: 2 }}>{props.hint}</div>}
      </div>
      {props.children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  background: C.card,
  border: `1px solid ${C.border}`,
  color: C.text,
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: 13,
}

const buttonStyle: React.CSSProperties = {
  background: C.card,
  border: `1px solid ${C.border}`,
  color: C.text,
  borderRadius: 4,
  padding: '5px 12px',
  cursor: 'pointer',
  fontSize: 13,
}

/** The Cloud Sync tab body. */
export function CloudSyncTab(props: { scope: CloudSyncScope }) {
  const snapshot = useScope(props.scope)
  const value = snapshot.value
  const writable = snapshot.writable

  if (snapshot.status === 'loading') {
    return <div style={{ color: C.dim, fontSize: 13, padding: 12 }}>Loading Cloud Sync…</div>
  }
  if (snapshot.status === 'unavailable' || value === undefined) {
    return <div style={{ color: C.dim, fontSize: 13, padding: 12 }}>The cloud-sync namespace is not available in this session.</div>
  }

  const write = (field: string, next: unknown): void => { void props.scope.set(field, next) }

  const lastLine = value.lastSyncAt === ''
    ? 'Not synced yet.'
    : `${value.lastSyncStatus} · ${value.lastSyncFiles} file${value.lastSyncFiles === 1 ? '' : 's'} · ${value.lastSyncAt}`

  return (
    <div style={{ background: C.panel, color: C.text, padding: 14, borderRadius: 8, fontSize: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <strong>Cloud Sync</strong>
        <span style={{ color: value.enabled ? C.ok : C.dim, fontSize: 12 }}>
          {value.enabled ? 'enabled' : 'disabled'}
        </span>
      </div>
      <div style={{ color: C.dim, fontSize: 12, margin: '4px 0 10px' }}>
        Mirrors the harness home (sessions, settings, skills, attachments) into a local
        OneDrive/Google Drive folder; that app&apos;s own client uploads it. Your API key and
        the machine-specific <code>profiles/</code> tree are never copied.
      </div>

      <Row label="Enabled" hint="Start syncing now and on the interval below.">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={!writable}
          onChange={(event) => { write('enabled', event.target.checked) }}
        />
      </Row>

      <Row label="Provider" hint="OneDrive and Google Drive are auto-detected from their desktop folders.">
        <select
          value={value.provider}
          disabled={!writable}
          onChange={(event) => { write('provider', event.target.value) }}
          style={inputStyle}
        >
          <option value="onedrive">OneDrive</option>
          <option value="google-drive">Google Drive</option>
          <option value="custom">Custom folder</option>
        </select>
      </Row>

      <Row label="Target folder" hint="Leave empty to auto-detect; otherwise an absolute path.">
        <input
          type="text"
          value={value.target}
          disabled={!writable}
          placeholder="auto-detect"
          onChange={(event) => { write('target', event.target.value) }}
          style={{ ...inputStyle, width: 260 }}
        />
      </Row>

      <Row label="Sync interval (minutes)" hint="How often to mirror while enabled.">
        <input
          type="number"
          min={1}
          max={10080}
          value={value.intervalMinutes}
          disabled={!writable}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10)
            if (!Number.isNaN(parsed)) write('intervalMinutes', parsed)
          }}
          style={{ ...inputStyle, width: 90 }}
        />
      </Row>

      <Row label="Restore on startup" hint="Pull the cloud folder back into the harness home at boot (new-machine restore).">
        <input
          type="checkbox"
          checked={value.restoreOnStartup}
          disabled={!writable}
          onChange={(event) => { write('restoreOnStartup', event.target.checked) }}
        />
      </Row>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <button
          type="button"
          disabled={!writable || !value.enabled}
          onClick={() => { write('syncRequest', value.syncRequest + 1) }}
          style={{ ...buttonStyle, opacity: writable && value.enabled ? 1 : 0.5 }}
        >
          Sync now
        </button>
        <span style={{ color: C.dim, fontSize: 12 }}>{lastLine}</span>
      </div>
    </div>
  )
}

/** Contribute the Cloud Sync tab to Settings → Plugins. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<CloudSyncSettings>({ namespace: 'cloud-sync' }) as unknown as CloudSyncScope

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'cloud-sync',
    order: 30,
    label: () => 'Cloud Sync',
    inject: () => ({ scope }),
  }, CloudSyncTab))
}
