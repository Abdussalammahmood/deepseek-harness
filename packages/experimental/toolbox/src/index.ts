/**
 * Toolbox host half: owns the `toolbox` settings namespace that describes the
 * MCP servers installed by the DSH MCP toolbox, and writes the user's choices
 * back into that toolbox's own manifests.
 *
 * The toolbox folder stays the single source of truth. This plugin reads the
 * manifests to publish their servers, tools, and descriptions to the browser
 * UI, and on a settings change it updates the same manifests and asks the
 * toolbox manager (`mcp.ps1 patch`) to regenerate the DSH profile patch, so the
 * profile reloads live and no second patch writer exists.
 *
 * @module @deepseek-ai/dsh-toolbox
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

export const name = 'toolbox'
export const inject = ['settings']

/** Settings namespace this plugin owns; the browser card keys on the same string. */
export const NS = 'toolbox'

/**
 * Tools whose presence means a server can drive the machine rather than just
 * answer a question. Used only to classify a server for the UI warning.
 */
const CONTROL_TOOLS: readonly string[] = [
  'Screenshot', 'Snapshot', 'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'App',
  'PowerShell', 'FileSystem', 'Registry', 'Process', 'Clipboard', 'MultiSelect', 'MultiEdit',
]

/** One published MCP server. */
export interface ToolboxServer {
  /** Manifest id, stable across edits. */
  id: string
  /** Human title shown in the UI. */
  title: string
  /** MCP namespace; its tools appear to the model as `mcp__<serverName>__<tool>`. */
  serverName: string
  /** Free-text description shown in the UI. */
  description: string
  /** Whether the server is currently enabled. */
  enabled: boolean
  /** `control` when the server advertises machine-controlling tools. */
  risk: 'control' | 'normal'
  /** Every tool the server advertises. */
  tools: string[]
  /** The subset that can control the machine. */
  controlTools: string[]
  /** Tools the user switched off. */
  hiddenTools: string[]
}

/** Plugin config, doubling as the `toolbox` settings-section shape. */
export interface Config {
  /** Published servers, defaulted from the toolbox manifests. */
  servers: ToolboxServer[]
}

const serverSchema = z.object({
  id: z.string().required(),
  title: z.string().default(''),
  serverName: z.string().required(),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  risk: z.union(['control', 'normal']).default('normal'),
  tools: z.array(z.string()).default([]),
  controlTools: z.array(z.string()).default([]),
  hiddenTools: z.array(z.string()).default([]),
})

export const Config: z<Config> = z.object({
  servers: z.array(serverSchema).default([]),
})

/** The subset of a toolbox manifest this plugin reads and writes. */
interface Manifest {
  id: string
  title?: string
  description?: string
  serverName: string
  enabled?: boolean
  knownTools?: string[]
  toolFilter?: { style?: string; envVar?: string; excluded?: string[] }
}

/** Toolbox folder; overridable for tests or a relocated toolbox. */
export function toolboxRoot(): string {
  return process.env.DSH_TOOLBOX_ROOT ?? 'D:\\deepseekHarnes\\mcp'
}

/** Absolute manifest path per server id, filled by {@link discover}. */
const manifestPathById = new Map<string, string>()

/**
 * Read every manifest and publish it as a server entry.
 * @returns one entry per readable manifest, ordered by file name.
 */
export function discover(): ToolboxServer[] {
  const dir = join(toolboxRoot(), 'servers')
  let files: string[]
  try {
    files = readdirSync(dir).filter(file => file.endsWith('.json')).sort()
  } catch {
    return []
  }
  const servers: ToolboxServer[] = []
  for (const file of files) {
    const path = join(dir, file)
    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    } catch {
      continue
    }
    if (typeof manifest.id !== 'string' || typeof manifest.serverName !== 'string') continue
    const tools = manifest.knownTools ?? []
    const controlTools = tools.filter(tool => CONTROL_TOOLS.includes(tool))
    manifestPathById.set(manifest.id, path)
    servers.push({
      id: manifest.id,
      title: manifest.title ?? manifest.id,
      serverName: manifest.serverName,
      description: manifest.description ?? '',
      enabled: manifest.enabled !== false,
      risk: controlTools.length > 0 ? 'control' : 'normal',
      tools: [...tools],
      controlTools,
      hiddenTools: [...(manifest.toolFilter?.excluded ?? [])],
    })
  }
  return servers
}

/** Comparable form of the fields this plugin owns, for change detection. */
function signature(servers: readonly ToolboxServer[]): string {
  return JSON.stringify(servers
    .map(server => ({ id: server.id, enabled: server.enabled, hidden: [...server.hiddenTools].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id)))
}

/**
 * Write chosen enablement and hidden tools into the manifests, then let the
 * toolbox manager regenerate the DSH patch (one patch writer, live reload).
 */
function applyToManifests(servers: readonly ToolboxServer[], log: (message: string) => void): void {
  for (const server of servers) {
    const path = manifestPathById.get(server.id)
    if (path === undefined) continue
    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    } catch {
      continue
    }
    manifest.enabled = server.enabled
    if (manifest.toolFilter !== undefined) manifest.toolFilter.excluded = [...server.hiddenTools]
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  const script = join(toolboxRoot(), 'mcp.ps1')
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'patch'],
    { stdio: 'ignore', windowsHide: true },
  )
  child.on('error', (error: unknown) => {
    log(`toolbox: manifest updated but the DSH patch was not regenerated: ${String(error)}`)
  })
}

/**
 * Register the `toolbox` settings namespace.
 * @param ctx - host plugin context.
 * @param config - composition config; its `servers` default is replaced by the live manifest scan.
 */
export function apply(ctx: Context, config: Config): void {
  const discovered = discover()
  let applied = signature(discovered)
  let current: () => Config = () => ({ servers: discovered })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, { ...config, servers: discovered }, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        const servers = current().servers
        const next = signature(servers)
        if (next === applied) return
        applied = next
        try {
          applyToManifests(servers, message => ctx.logger.info(message))
        } catch (error) {
          ctx.logger.error(`toolbox: failed to apply settings: ${String(error)}`)
        }
      },
    })
  })
}
