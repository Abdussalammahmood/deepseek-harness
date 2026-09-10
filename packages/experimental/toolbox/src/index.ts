/**
 * Toolbox host half: owns the `toolbox` settings namespace that describes the
 * MCP servers, native tool providers, and skills this deployment offers, and
 * applies the user's switches.
 *
 * Three sources of truth, one writer each:
 * - MCP servers live in the toolbox manifests; this plugin writes choices back
 *   into the same manifests the `mcp.ps1` CLI edits.
 * - Native tool providers are switched off by writing ids into the toolbox's
 *   `plugins.json`, which `mcp.ps1 patch` turns into id-targeted disable rows.
 * - A filesystem skill is switched off the way DSH itself switches one off: the
 *   `disable-model-invocation` key in its own frontmatter, which the skill
 *   provider's watcher picks up with no patch involved.
 *
 * @module @deepseek-ai/dsh-toolbox
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'toolbox'
export const inject = ['settings', 'tools']

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

/** Skill sources whose bodies this plugin must not rewrite. */
const READ_ONLY_SOURCES: ReadonlySet<string> = new Set(['bundled'])

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
  /** Whether model-facing catalogs currently include the skill. */
  modelInvocable: boolean
  /** Whether this plugin can rewrite the skill's own frontmatter. */
  switchable: boolean
  /** Absolute path of the skill file, when this plugin can find it. */
  path?: string
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
  modelInvocable: z.boolean().default(true),
  switchable: z.boolean().default(false),
  path: z.string(),
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

/** A skill as the registry reports it, narrowed to what this plugin needs. */
interface ListedSkill {
  name: string
  description: string
  source?: string
  provider?: string
  invocation?: { modelInvocable?: boolean }
  resourceBase?: { kind?: string; path?: string; url?: string; description?: string }
}

/** The skill registry surface this plugin reads. */
interface SkillListable {
  list: (options?: object) => Promise<readonly ListedSkill[]>
}

/**
 * Locate the file backing one skill, when it is a filesystem skill.
 * @param skill - the listed skill.
 * @returns the absolute SKILL.md or flat skill path, or undefined.
 */
function skillFile(skill: ListedSkill): string | undefined {
  const base = skill.resourceBase
  if (base === undefined || base.kind !== 'directory' || typeof base.path !== 'string') return undefined
  const bundle = join(base.path, 'SKILL.md')
  if (existsSync(bundle)) return bundle
  const flat = join(base.path, `${skill.name}.md`)
  if (existsSync(flat)) return flat
  return undefined
}

/**
 * Flip one skill's model visibility the way DSH reads it: the
 * `disable-model-invocation` key in the skill's own frontmatter.
 * @param file - absolute skill file.
 * @param invocable - whether model-facing catalogs should include it.
 * @returns whether the file changed.
 */
export function setModelInvocable(file: string, invocable: boolean): boolean {
  const text = readFileSync(file, 'utf8')
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (front === null || front[1] === undefined) return false
  const current = front[1]
  const line = `disable-model-invocation: ${invocable ? 'false' : 'true'}`
  const body = /^disable-model-invocation:.*$/m.test(current)
    ? current.replace(/^disable-model-invocation:.*$/m, line)
    : `${current}\n${line}`
  const next = `${text.slice(0, front.index)}---\n${body}\n---${text.slice(front.index + front[0].length)}`
  if (next === text) return false
  writeFileSync(file, next, 'utf8')
  return true
}

/**
 * Every installed skill, with the switch state and the file this plugin may edit.
 * @param ctx - host plugin context.
 * @returns skills in registry order, or an empty list without the service.
 */
export async function discoverSkills(ctx: Context): Promise<ToolboxSkill[]> {
  const skills = ctx.get('skills') as unknown as SkillListable | undefined
  if (skills === undefined || typeof skills.list !== 'function') return []
  try {
    const listed = await skills.list({})
    return listed.map((skill) => {
      const path = skillFile(skill)
      const source = skill.source ?? ''
      const switchable = path !== undefined && !READ_ONLY_SOURCES.has(source)
      return {
        name: skill.name,
        description: skill.description,
        source,
        provider: skill.provider ?? '',
        modelInvocable: skill.invocation?.modelInvocable !== false,
        switchable,
        ...path === undefined || !switchable ? {} : { path },
      }
    })
  } catch {
    return []
  }
}

/** Comparable form of the MCP server switches, for change detection. */
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

/** Comparable form of the skill switches, for change detection. */
function skillSignature(skills: readonly ToolboxSkill[]): string {
  return JSON.stringify(skills
    .filter(skill => skill.switchable)
    .map(skill => ({ name: skill.name, on: skill.modelInvocable }))
    .sort((a, b) => a.name.localeCompare(b.name)))
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
 * Flip the frontmatter of every switchable skill whose state the user changed.
 * No patch is regenerated: the skill provider watches its roots.
 * @param skills - the desired skill switches.
 * @param log - diagnostic sink.
 */
function applySkills(skills: readonly ToolboxSkill[], log: (message: string) => void): void {
  for (const skill of skills) {
    if (!skill.switchable || skill.path === undefined) continue
    try {
      setModelInvocable(skill.path, skill.modelInvocable)
    } catch (error) {
      log(`toolbox: could not update skill "${skill.name}": ${String(error)}`)
    }
  }
}

/**
 * Register the `toolbox` settings namespace.
 * @param ctx - host plugin context.
 * @param config - composition config; its published lists are replaced by live discovery.
 */
/** Arguments of one `toolbox` tool call. */
interface ToolActionArgs {
  action: string
  target?: string
  tools?: string
}

/** Read one manifest, mutate it, and write it back. */
function mutateManifest(id: string, mutate: (manifest: Manifest) => void): void {
  const path = manifestPathById.get(id)
  if (path === undefined) {
    throw new Error(`unknown MCP server "${id}"; known: ${[...manifestPathById.keys()].join(', ') || '(none)'}`)
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  mutate(manifest)
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * Human-readable toolbox state.
 * @param ctx - host plugin context.
 * @returns one line per server, provider, and skill.
 */
export async function toolboxStatus(ctx: Context): Promise<string> {
  const servers = discover()
  const groups = discoverToolGroups(ctx)
  const skills = await discoverSkills(ctx)
  const lines: string[] = [`MCP servers (${servers.length}):`]
  for (const server of servers) {
    const off = server.hiddenTools.length > 0 ? `, ${server.hiddenTools.length} tools off` : ''
    const risk = server.risk === 'control' ? ' CONTROLS PC' : ''
    lines.push(`  ${server.enabled ? 'on ' : 'OFF'} ${server.id} [${server.serverName}]${risk} - ${server.tools.length} tools${off}`)
  }
  lines.push(`Native tool providers (${groups.length}):`)
  for (const group of groups) {
    const entry = group.entryId === undefined ? '' : ` [${group.entryId}]`
    lines.push(`  ${group.enabled ? 'on ' : 'OFF'} ${group.plugin}${entry} - ${group.tools.length} tools`)
  }
  lines.push(`Skills (${skills.length}):`)
  for (const skill of skills) {
    lines.push(`  ${skill.modelInvocable ? 'on ' : 'OFF'} ${skill.name} (${skill.source})${skill.switchable ? '' : ' read-only'}`)
  }
  return lines.join('\n')
}

/**
 * Run the toolbox installer and return its tail.
 * @returns the exit status plus the last lines of output.
 */
async function runToolboxSetup(): Promise<string> {
  const script = join(toolboxRoot(), 'mcp.ps1')
  return await new Promise<string>((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'setup'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: { toString: () => string }) => { out += chunk.toString() })
    child.stderr.on('data', (chunk: { toString: () => string }) => { out += chunk.toString() })
    child.on('error', (error: unknown) => { resolve(`toolbox setup failed to start: ${String(error)}`) })
    child.on('close', (code: number | null) => {
      const tail = out.trim().split('\n').slice(-25).join('\n')
      resolve(`toolbox setup exited ${String(code)}\n${tail}`)
    })
  })
}

/**
 * Execute one `toolbox` tool action.
 * @param args - the action, its target, and any tool names.
 * @param ctx - host plugin context.
 * @returns a human-readable result.
 */
export async function runToolAction(args: ToolActionArgs, ctx: Context): Promise<string> {
  const need = (): string => {
    if (args.target === undefined || args.target === '') throw new Error(`action "${args.action}" needs a target`)
    return args.target
  }
  switch (args.action) {
    case 'status':
      return await toolboxStatus(ctx)
    case 'setup':
      return await runToolboxSetup()
    case 'server_enable':
    case 'server_disable': {
      const id = need()
      mutateManifest(id, (manifest) => { manifest.enabled = args.action === 'server_enable' })
      regeneratePatch(() => { /* the tool reports its own result */ })
      return `${args.action === 'server_enable' ? 'enabled' : 'disabled'} MCP server ${id}`
    }
    case 'tool_enable':
    case 'tool_disable': {
      const names = (args.tools ?? '').split(',').map(name => name.trim()).filter(name => name !== '')
      if (names.length === 0) throw new Error(`action "${args.action}" needs comma-separated tool names in "tools"`)
      const id = need()
      mutateManifest(id, (manifest) => {
        const excluded = new Set(manifest.toolFilter?.excluded ?? [])
        for (const name of names) {
          if (args.action === 'tool_disable') excluded.add(name)
          else excluded.delete(name)
        }
        if (manifest.toolFilter !== undefined) manifest.toolFilter.excluded = [...excluded]
      })
      regeneratePatch(() => { /* the tool reports its own result */ })
      return `${args.action === 'tool_disable' ? 'hid' : 'restored'} ${names.join(', ')} on ${id}`
    }
    case 'provider_enable':
    case 'provider_disable': {
      const id = need()
      const disabled = new Set(readPluginsDoc().disabledPlugins ?? [])
      if (args.action === 'provider_disable') disabled.add(id)
      else disabled.delete(id)
      writeDisabledPlugins([...disabled])
      regeneratePatch(() => { /* the tool reports its own result */ })
      return `${args.action === 'provider_disable' ? 'disabled' : 'enabled'} tool provider ${id}`
    }
    case 'skill_enable':
    case 'skill_disable': {
      const name = need()
      const skill = (await discoverSkills(ctx)).find(candidate => candidate.name === name)
      if (skill === undefined) throw new Error(`no such skill "${name}"`)
      if (!skill.switchable || skill.path === undefined) throw new Error(`skill "${name}" is read-only`)
      setModelInvocable(skill.path, args.action === 'skill_enable')
      return `${args.action === 'skill_enable' ? 'enabled' : 'disabled'} skill ${name}`
    }
    default:
      throw new Error(`unknown action "${args.action}"`)
  }
}

/**
 * Register the model-facing `toolbox` tool.
 * @param ctx - host plugin context.
 */
function registerTool(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'toolbox',
    description: 'Inspect and change this machine\'s DeepSeek Harness toolbox: MCP servers, native tool providers, and installed skills. Start with action "status" to list ids, then enable or disable by id.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'status, setup, server_enable, server_disable, tool_enable, tool_disable, provider_enable, provider_disable, skill_enable, skill_disable',
      },
      target: { type: 'string', description: 'MCP server id, provider entry id, or skill name, depending on the action' },
      tools: { type: 'string', description: 'Comma-separated MCP tool names, for tool_enable and tool_disable' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return await runToolAction({
        action: args.action,
        ...args.target === undefined ? {} : { target: args.target },
        ...args.tools === undefined ? {} : { tools: args.tools },
      }, ctx)
    },
  })))
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const servers = discover()
  const toolGroups = discoverToolGroups(ctx)
  const skills = await discoverSkills(ctx)
  const defaults: Config = { servers, toolGroups, skills }

  let appliedServers = serverSignature(servers)
  let appliedGroups = groupSignature(toolGroups)
  let appliedSkills = skillSignature(skills)
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
        let patchNeeded = false
        try {
          const serverNext = serverSignature(next.servers)
          if (serverNext !== appliedServers) {
            appliedServers = serverNext
            applyServers(next.servers)
            patchNeeded = true
          }
          const groupNext = groupSignature(next.toolGroups)
          if (groupNext !== appliedGroups) {
            appliedGroups = groupNext
            const off = next.toolGroups
              .filter(group => !group.enabled && group.entryId !== undefined)
              .map(group => group.entryId as string)
            if (writeDisabledPlugins(off)) patchNeeded = true
          }
          const skillNext = skillSignature(next.skills)
          if (skillNext !== appliedSkills) {
            appliedSkills = skillNext
            applySkills(next.skills, (message) => { ctx.logger.info(message) })
          }
          if (patchNeeded) regeneratePatch((message) => { ctx.logger.info(message) })
        } catch (error) {
          ctx.logger.error(`toolbox: failed to apply settings: ${String(error)}`)
        }
      },
    })
  })
  registerTool(ctx)
}
