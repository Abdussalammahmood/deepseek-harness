/**
 * Toolbox host half: owns the `toolbox` settings namespace that describes the
 * MCP servers, native tools, and skills this deployment offers, and writes the
 * user's server/tool choices back into the MCP toolbox manifests.
 *
 * The toolbox folder stays the single source of truth for MCP servers. This
 * plugin reads the manifests to publish their servers, tools, and descriptions
 * to the browser UI, and on a settings change it updates the same manifests and
 * asks the toolbox manager (`mcp.ps1 patch`) to regenerate the DSH profile
 * patch, so the profile reloads live and no second patch writer exists.
 *
 * @module @deepseek-ai/dsh-toolbox
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'toolbox'
export const inject = ['settings']

/** Settings namespace this plugin owns; the browser tab keys on the same string. */
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

/** One native (non-MCP) model-facing tool. */
export interface ToolboxTool {
  /** Model-visible tool name. */
  name: string
  /** Description the model sees. */
  description: string
}

/** One installed skill. */
export interface ToolboxSkill {
  /** Kebab-case skill id. */
  name: string
  /** Routing description. */
  description: string
  /** Discovery source that produced the winning skill. */
  source: string
  /** Provider that owns the skill body. */
  provider: string
}

/** Plugin config, doubling as the `toolbox` settings-section shape. */
export interface Config {
  /** Published MCP servers, defaulted from the toolbox manifests. */
  servers: ToolboxServer[]
  /** Native model-facing tools, defaulted from the live tool registry. */
  nativeTools: ToolboxTool[]
  /** Installed skills, defaulted from the live skill registry. */
  skills: ToolboxSkill[]
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

const toolSchema = z.object({
  name: z.string().required(),
  description: z.string().default(''),
})

const skillSchema = z.object({
  name: z.string().required(),
  description: z.string().default(''),
  source: z.string().default(''),
  provider: z.string().default(''),
})

export const Config: z<Config> = z.object({
  servers: z.array(serverSchema).default([]),
  nativeTools: z.array(toolSchema).default([]),
  skills: z.array(skillSchema).default([]),
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

/** The registry surface this plugin reads. */
interface ToolSchemas {
  schemas: () => readonly { name: string; description?: string }[]
}

/**
 * Every model-facing tool the registry currently exposes, minus the MCP-bridged
 * ones (those belong to their own server entry).
 * @param ctx - host plugin context.
 * @returns native tools in registry order, or an empty list without the service.
 */
export function discoverTools(ctx: Context): ToolboxTool[] {
  const tools = ctx.get('tools') as unknown as ToolSchemas | undefined
  if (tools === undefined || typeof tools.schemas !== 'function') return []
  try {
    return tools.schemas()
      .filter(schema => !schema.name.startsWith('mcp__'))
      .map(schema => ({ name: schema.name, description: schema.description ?? '' }))
  } catch {
    return []
  }
}

/** The skill registry surface this plugin reads. */
interface SkillListable {
  list: (options?: object) => Promise<readonly {
    name: string
    description: string
    source?: string
    provider?: string
  }[]>
}

/**
 * Every installed skill.
 * @param ctx - host plugin context.
 * @returns skills in registry order, or an empty list without the service.
 */
export async function discoverSkills(ctx: Context): Promise<ToolboxSkill[]> {
  const skills = ctx.get('skills') as unknown as SkillListable | undefined
  if (skills === undefined || typeof skills.list !== 'function') return []
  try {
    const listed = await skills.list({})
    return listed.map(skill => ({
      name: skill.name,
      description: skill.description,
      source: skill.source ?? '',
      provider: skill.provider ?? '',
    }))
  } catch {
    return []
  }
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
 * @param config - composition config; its published lists are replaced by live discovery.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const discovered = discover()
  const nativeTools = discoverTools(ctx)
  const skills = await discoverSkills(ctx)
  const defaults: Config = { servers: discovered, nativeTools, skills }
  let applied = signature(discovered)
  let current: () => Config = () => defaults

  ctx.inject(['settings'], (settingsCtx) => {
    const composition: Config = {
      servers: defaults.servers.length > 0 ? defaults.servers : config.servers,
      nativeTools: defaults.nativeTools,
      skills: defaults.skills,
    }
    settingsCtx.settings.installSection(ctx, NS, Config, composition, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        const servers = current().servers
        const next = signature(servers)
        if (next === applied) return
        applied = next
        try {
          applyToManifests(servers, (message) => { ctx.logger.info(message) })
        } catch (error) {
          ctx.logger.error(`toolbox: failed to apply settings: ${String(error)}`)
        }
      },
    })
  })
}
