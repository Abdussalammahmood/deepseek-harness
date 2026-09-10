/**
 * Toolbox host half: owns the `toolbox` settings namespace that describes the
 * MCP servers, native tool providers, and skills this deployment offers, and
 * applies the user's switches.
 *
 * Two sources of truth, one writer each:
 * - MCP servers live in the toolbox manifests; this plugin writes choices back
 *   into the same manifests the `mcp.ps1` CLI edits.
 * - Native tool providers are switched off by writing ids into the toolbox's
 *   `plugins.json`, which `mcp.ps1 patch` turns into id-targeted disable rows.
 * Either way the toolbox manager regenerates the DSH profile patch, so the
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

/**
 * Entry ids the UI must never switch off: the tool registry itself owns the
 * reserved PTC transport, and disabling it would remove every tool at once.
 */
const UNTOGGLEABLE: ReadonlySet<string> = new Set(['tools', 'toolbox', 'ui-toolbox'])

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

/** One model-facing tool. */
export interface ToolboxTool {
  /** Model-visible tool name. */
  name: string
  /** Description the model sees. */
  description: string
}

/** Native tools grouped by the plugin that contributes them. */
export interface ToolboxToolGroup {
  /** npm package that contributes the tools, or `(other)` for unidentified ones. */
  plugin: string
  /** Loader entry id that can be switched off, absent when unidentified. */
  entryId?: string
  /** The tools this provider contributes. */
  tools: ToolboxTool[]
  /** Whether the provider is currently on. */
  enabled: boolean
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
  /** Native tools grouped by provider, defaulted from the registry plus the shipped catalogs. */
  toolGroups: ToolboxToolGroup[]
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

const toolGroupSchema = z.object({
  plugin: z.string().required(),
  entryId: z.string(),
  tools: z.array(toolSchema).default([]),
  enabled: z.boolean().default(true),
})

const skillSchema = z.object({
  name: z.string().required(),
  description: z.string().default(''),
  source: z.string().default(''),
  provider: z.string().default(''),
})

export const Config: z<Config> = z.object({
  servers: z.array(serverSchema).default([]),
  toolGroups: z.array(toolGroupSchema).default([]),
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

/** The subset of `plugins.json` this plugin reads and writes. */
interface PluginsDoc {
  harnessRoot?: string
  plugins?: unknown[]
  disabledPlugins?: string[]
}

/** Toolbox folder; overridable for tests or a relocated toolbox. */
export function toolboxRoot(): string {
  return process.env.DSH_TOOLBOX_ROOT ?? 'D:\\deepseekHarnes\\mcp'
}

/** Harness checkout the catalogs are read from. */
export function harnessRoot(): string {
  if (process.env.DSH_HARNESS_ROOT !== undefined) return process.env.DSH_HARNESS_ROOT
  try {
    const doc = JSON.parse(readFileSync(join(toolboxRoot(), 'plugins.json'), 'utf8')) as PluginsDoc
    if (typeof doc.harnessRoot === 'string' && doc.harnessRoot !== '') return doc.harnessRoot
  } catch { /* fall through to the default */ }
  return 'D:\\deepseekHarnes\\deepseek-harness'
}

/** Absolute manifest path per server id, filled by {@link discover}. */
const manifestPathById = new Map<string, string>()

/** Run the one patch generator, so this plugin never writes the DSH patch itself. */
function regeneratePatch(log: (message: string) => void): void {
  const script = join(toolboxRoot(), 'mcp.ps1')
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'patch'],
    { stdio: 'ignore', windowsHide: true },
  )
  child.on('error', (error: unknown) => {
    log(`toolbox: settings applied but the DSH patch was not regenerated: ${String(error)}`)
  })
}

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

/**
 * Map each shipped tool package to the model-visible names it contributes,
 * read from the generated tool catalog the repository verifies in CI.
 * @param root - harness checkout root.
 * @returns package to tool names.
 */
export function readCatalogMap(root: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  let text: string
  try {
    text = readFileSync(join(root, 'docs', 'tool-catalog.md'), 'utf8')
  } catch {
    return map
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map(cell => cell.trim())
    if (cells.length < 4) continue
    const pkgCell = cells[1]
    const namesCell = cells[2]
    if (pkgCell === undefined || namesCell === undefined) continue
    const pkg = pkgCell.replace(/`/g, '')
    if (!pkg.startsWith('@')) continue
    const names = [...namesCell.matchAll(/`([^`]+)`/g)]
      .flatMap(match => (match[1] === undefined ? [] : [match[1]]))
    if (names.length > 0) map.set(pkg, names)
  }
  return map
}

/**
 * Map each shipped package to its loader entry id, read from the shipped bundle
 * patches, so a switch can name the row it disables.
 * @param root - harness checkout root.
 * @returns package name to loader entry id.
 */
export function readEntryIds(root: string): Map<string, string> {
  const map = new Map<string, string>()
  const bundles = join(root, 'packages', 'bundle')
  let dirs: string[]
  try {
    dirs = readdirSync(bundles)
  } catch {
    return map
  }
  for (const dir of dirs) {
    let text: string
    try {
      text = readFileSync(join(bundles, dir, 'cordis.patch.yml'), 'utf8')
    } catch {
      continue
    }
    const re = /-\s*id:\s*(\S+)\s*\r?\n\s*name:\s*'?([^'\r\n]+)'?/g
    let match = re.exec(text)
    while (match !== null) {
      const id = match[1]
      const name = match[2]
      if (id !== undefined && name !== undefined) map.set(name.trim(), id)
      match = re.exec(text)
    }
  }
  return map
}

/**
 * Group the live native tools by the plugin that contributes them, so each
 * group can carry one switch.
 * @param ctx - host plugin context.
 * @returns groups in package order, with an `(other)` group for unidentified tools.
 */
export function discoverToolGroups(ctx: Context): ToolboxToolGroup[] {
  const tools = discoverTools(ctx)
  if (tools.length === 0) return []
  const root = harnessRoot()
  const catalog = readCatalogMap(root)
  const entryIds = readEntryIds(root)
  const disabled = new Set(readPluginsDoc().disabledPlugins ?? [])

  const packageForTool = new Map<string, string>()
  for (const [pkg, names] of catalog) {
    for (const name of names) packageForTool.set(name, pkg)
  }

  const grouped = new Map<string, ToolboxTool[]>()
  const other: ToolboxTool[] = []
  for (const tool of tools) {
    const pkg = packageForTool.get(tool.name)
    if (pkg === undefined) {
      other.push(tool)
      continue
    }
    const list = grouped.get(pkg) ?? []
    list.push(tool)
    grouped.set(pkg, list)
  }

  const groups: ToolboxToolGroup[] = []
  for (const [pkg, list] of [...grouped].sort((a, b) => a[0].localeCompare(b[0]))) {
    const entryId = entryIds.get(pkg)
    if (entryId !== undefined && UNTOGGLEABLE.has(entryId)) continue
    groups.push({
      plugin: pkg,
      ...entryId === undefined ? {} : { entryId },
      tools: list,
      enabled: entryId === undefined ? true : !disabled.has(entryId),
    })
  }
  if (other.length > 0) groups.push({ plugin: '(other)', tools: other, enabled: true })
  return groups
}

/** Read the toolbox plugin document. */
function readPluginsDoc(): PluginsDoc {
  try {
    return JSON.parse(readFileSync(join(toolboxRoot(), 'plugins.json'), 'utf8')) as PluginsDoc
  } catch {
    return {}
  }
}

/**
 * Record the switched-off provider entry ids, in the document `mcp.ps1` reads.
 * @param ids - loader entry ids to disable.
 * @returns whether the document changed.
 */
function writeDisabledPlugins(ids: readonly string[]): boolean {
  const path = join(toolboxRoot(), 'plugins.json')
  const doc = readPluginsDoc()
  const next = [...ids].sort()
  const before = [...doc.disabledPlugins ?? []].sort()
  if (before.length === next.length && before.every((id, index) => id === next[index])) return false
  doc.disabledPlugins = next
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  return true
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

/** Comparable form of the server switches, for change detection. */
function serverSignature(servers: readonly ToolboxServer[]): string {
  return JSON.stringify(servers
    .map(server => ({ id: server.id, enabled: server.enabled, hidden: [...server.hiddenTools].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id)))
}

/** Comparable form of the provider switches, for change detection. */
function groupSignature(groups: readonly ToolboxToolGroup[]): string {
  return JSON.stringify(groups
    .filter(group => group.entryId !== undefined)
    .map(group => ({ id: group.entryId, enabled: group.enabled }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id))))
}

/** Write chosen enablement and hidden tools into the MCP manifests. */
function applyServers(servers: readonly ToolboxServer[]): void {
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
}

/**
 * Register the `toolbox` settings namespace.
 * @param ctx - host plugin context.
 * @param config - composition config; its published lists are replaced by live discovery.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const servers = discover()
  const toolGroups = discoverToolGroups(ctx)
  const skills = await discoverSkills(ctx)
  const defaults: Config = { servers, toolGroups, skills }

  let appliedServers = serverSignature(servers)
  let appliedGroups = groupSignature(toolGroups)
  let current: () => Config = () => defaults

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, {
      servers: servers.length > 0 ? servers : config.servers,
      toolGroups: toolGroups.length > 0 ? toolGroups : config.toolGroups,
      skills: skills.length > 0 ? skills : config.skills,
    }, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        const next = current()
        let changed = false
        try {
          const serverNext = serverSignature(next.servers)
          if (serverNext !== appliedServers) {
            appliedServers = serverNext
            applyServers(next.servers)
            changed = true
          }
          const groupNext = groupSignature(next.toolGroups)
          if (groupNext !== appliedGroups) {
            appliedGroups = groupNext
            const off = next.toolGroups
              .filter(group => !group.enabled && group.entryId !== undefined)
              .map(group => group.entryId as string)
            if (writeDisabledPlugins(off)) changed = true
          }
          if (changed) regeneratePatch((message) => { ctx.logger.info(message) })
        } catch (error) {
          ctx.logger.error(`toolbox: failed to apply settings: ${String(error)}`)
        }
      },
    })
  })
}
