/**
 * Cloud-sync host half: owns the `cloud-sync` settings namespace and mirrors the
 * DeepSeek Harness home (sessions, storages, skills, attachments, settings) into a
 * local OneDrive / Google Drive folder. The cloud app's own desktop client performs
 * the authenticated upload, so this plugin stores no OAuth credentials.
 *
 * Never copied in either direction: `.credentials.yaml` (the API key), the
 * machine-specific `profiles/` tree, and any `.git` directory.
 *
 * @module @deepseek-ai/dsh-cloud-sync
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, stat, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'cloud-sync'
export const inject = ['settings']

/** Settings namespace this plugin owns; the browser tab keys on the same string. */
export const NS = 'cloud-sync'

export type CloudProvider = 'onedrive' | 'google-drive' | 'custom'

/** Plugin config, doubling as the `cloud-sync` settings-section shape. */
export interface CloudSyncConfig {
  /** Master switch; nothing is copied until this is on. */
  enabled: boolean
  /** Which cloud app's local folder to target. */
  provider: CloudProvider
  /** Absolute target folder; when empty, auto-detected from the provider. */
  target: string
  /** Cadence of the automatic sync, in minutes. */
  intervalMinutes: number
  /** Pull the cloud folder back into the harness home at boot. */
  restoreOnStartup: boolean
  /** Bump to request an immediate sync from the UI. */
  syncRequest: number
  /** ISO timestamp of the last finished pass. */
  lastSyncAt: string
  /** Human-readable last result. */
  lastSyncStatus: string
  /** Number of files copied by the last pass. */
  lastSyncFiles: number
}

export const Config: z<CloudSyncConfig> = z.object({
  enabled: z.boolean().default(false),
  provider: z.union(['onedrive', 'google-drive', 'custom']).default('onedrive'),
  target: z.string().default(''),
  intervalMinutes: z.number().min(1).max(10080).default(60),
  restoreOnStartup: z.boolean().default(false),
  syncRequest: z.number().min(0).default(0),
  lastSyncAt: z.string().default(''),
  lastSyncStatus: z.string().default('never synced'),
  lastSyncFiles: z.number().min(0).default(0),
})

function defaultConfig(): CloudSyncConfig {
  return {
    enabled: false,
    provider: 'onedrive',
    target: '',
    intervalMinutes: 60,
    restoreOnStartup: false,
    syncRequest: 0,
    lastSyncAt: '',
    lastSyncStatus: 'never synced',
    lastSyncFiles: 0,
  }
}

/** Path segments that must never cross the cloud boundary in either direction. */
const SECRET_NAMES: ReadonlySet<string> = new Set(['.credentials.yaml', 'profiles', '.git'])

/** One finished sync/restore pass, surfaced to the UI through the settings scope. */
export interface SyncResult {
  at: string
  status: string
  files: number
}

/** The harness home, via the canonical boot service when present. */
function harnessHome(ctx: Context): string {
  const fn = ctx.get('dshHomePath') as unknown as ((...segments: string[]) => string) | undefined
  if (typeof fn === 'function') {
    try {
      return fn()
    } catch { /* fall through to the environment-based resolver */ }
  }
  return resolveDshHome()
}

/** Locate the local cloud-root folder for a provider, when present. */
function detectCloudRoot(provider: CloudProvider): string | undefined {
  if (provider === 'onedrive') {
    const env = process.env.OneDrive ?? process.env.OneDriveConsumer
    if (env !== undefined && env.trim() !== '' && existsSync(env)) return env
    const home = join(homedir(), 'OneDrive')
    return existsSync(home) ? home : undefined
  }
  if (provider === 'google-drive') {
    const home = join(homedir(), 'Google Drive')
    return existsSync(home) ? home : undefined
  }
  return undefined
}

/** Absolute target folder for the configured provider (an explicit target wins). */
export function resolveTarget(config: { provider: CloudProvider; target: string }): string {
  const custom = config.target.trim()
  if (custom !== '') return custom
  const root = detectCloudRoot(config.provider)
  if (root === undefined) {
    throw new Error(`cannot locate a ${config.provider} folder on this machine; set a target path in Settings → Plugins → Cloud Sync`)
  }
  return join(root, 'DeepSeek Harness')
}

/** Copy `src` → `dst` recursively, skipping excluded names and unchanged files. */
async function copyTree(src: string, dst: string, exclude: ReadonlySet<string>): Promise<number> {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  let copied = 0
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue
    const source = join(src, entry.name)
    const target = join(dst, entry.name)
    if (entry.isDirectory()) {
      copied += await copyTree(source, target, exclude)
    } else if (entry.isFile()) {
      if (await copyIfChanged(source, target)) copied += 1
    }
  }
  return copied
}

/** Copy one file only when it differs from the target; preserve mtime for the next compare. */
async function copyIfChanged(source: string, target: string): Promise<boolean> {
  let sourceStat
  try {
    sourceStat = await stat(source)
  } catch {
    return false
  }
  try {
    const targetStat = await stat(target)
    if (targetStat.isFile() && targetStat.size === sourceStat.size && Math.abs(targetStat.mtimeMs - sourceStat.mtimeMs) < 1500) {
      return false
    }
  } catch {
    /* target is absent — copy it */
  }
  await copyFile(source, target)
  try {
    await utimes(target, sourceStat.atime, sourceStat.mtime)
  } catch {
    /* best-effort: mtime preservation only improves the next incremental pass */
  }
  return true
}

/** Push the harness home into the cloud folder. */
export async function syncOnce(config: CloudSyncConfig, home: string): Promise<SyncResult> {
  const target = resolveTarget(config)
  const copied = await copyTree(home, target, SECRET_NAMES)
  return { at: new Date().toISOString(), status: `synced ${copied} file${copied === 1 ? '' : 's'} → ${target}`, files: copied }
}

/** Pull the cloud folder back into the harness home (new-machine restore). */
export async function restoreOnce(config: CloudSyncConfig, home: string): Promise<SyncResult> {
  const source = resolveTarget(config)
  const copied = await copyTree(source, home, SECRET_NAMES)
  return { at: new Date().toISOString(), status: `restored ${copied} file${copied === 1 ? '' : 's'} ← ${source}`, files: copied }
}

/** Human-readable status for the model-facing tool. */
export function statusText(config: CloudSyncConfig): string {
  let target: string
  try {
    target = resolveTarget(config)
  } catch (error) {
    target = `(unresolved: ${error instanceof Error ? error.message : String(error)})`
  }
  return [
    `enabled: ${config.enabled ? 'yes' : 'no'}`,
    `provider: ${config.provider}`,
    `target: ${target}`,
    `interval: ${config.intervalMinutes} min`,
    `restore on startup: ${config.restoreOnStartup ? 'yes' : 'no'}`,
    `last sync: ${config.lastSyncAt === '' ? 'never' : config.lastSyncAt}`,
    `last result: ${config.lastSyncStatus}`,
    `last files: ${config.lastSyncFiles}`,
  ].join('\n')
}

/** The tool registry surface this plugin optionally reads. */
interface ToolRegistry {
  register: (tool: unknown) => () => void
}

/** Register the model-facing `cloud_sync` tool when the tools service exists. */
function registerTool(ctx: Context, readConfig: () => CloudSyncConfig, home: string): void {
  const tools = ctx.get('tools') as unknown as ToolRegistry | undefined
  if (tools === undefined || typeof tools.register !== 'function') return
  ctx.effect(() => tools.register(defineTool({
    name: 'cloud_sync',
    description: 'Sync or restore the DeepSeek Harness home against the configured local OneDrive/Google Drive folder. Actions: status (report config and last result), sync (push local changes to the cloud folder now), restore (pull the cloud folder back into the harness home).',
    parameters: {
      action: { type: 'string', required: true, description: 'status, sync, or restore' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const config = readConfig()
      switch (args.action) {
        case 'status':
          return statusText(config)
        case 'sync':
          return (await syncOnce(config, home)).status
        case 'restore':
          return (await restoreOnce(config, home)).status
        default:
          throw new Error(`unknown action "${args.action}"`)
      }
    },
  })))
}

export async function apply(ctx: Context, config: CloudSyncConfig): Promise<void> {
  const home = harnessHome(ctx)
  const base: CloudSyncConfig = { ...defaultConfig(), ...config }
  let readConfig: () => CloudSyncConfig = () => base

  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(NS, Config, { base })
    readConfig = () => scope.get()

    let timer: ReturnType<typeof setInterval> | undefined
    let running = false
    let busy = false
    let handledRequest = -1
    let currentIntervalMs = 0

    const record = (result: SyncResult): void => {
      scope.update({ lastSyncAt: result.at, lastSyncStatus: result.status, lastSyncFiles: result.files }).catch(() => {})
    }

    const runSync = (cfg: CloudSyncConfig): void => {
      if (busy) return
      busy = true
      syncOnce(cfg, home)
        .then(record)
        .catch((error: unknown) => record({ at: new Date().toISOString(), status: `sync error: ${String(error)}`, files: 0 }))
        .finally(() => { busy = false })
    }

    const runRestore = (cfg: CloudSyncConfig): void => {
      if (busy) return
      busy = true
      restoreOnce(cfg, home)
        .then(record)
        .catch((error: unknown) => record({ at: new Date().toISOString(), status: `restore error: ${String(error)}`, files: 0 }))
        .finally(() => { busy = false })
    }

    const stopTimer = (): void => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }

    const reconcile = (cfg: CloudSyncConfig): void => {
      const intervalMs = Math.max(1, cfg.intervalMinutes) * 60_000
      if (cfg.enabled && !running) {
        running = true
        currentIntervalMs = intervalMs
        if (cfg.restoreOnStartup) runRestore(cfg)
        runSync(cfg)
        stopTimer()
        timer = setInterval(() => { runSync(scope.get()) }, intervalMs)
      } else if (!cfg.enabled && running) {
        running = false
        currentIntervalMs = 0
        stopTimer()
      } else if (running && intervalMs !== currentIntervalMs) {
        currentIntervalMs = intervalMs
        stopTimer()
        timer = setInterval(() => { runSync(scope.get()) }, intervalMs)
      }
      if (cfg.syncRequest !== handledRequest) {
        handledRequest = cfg.syncRequest
        runSync(cfg)
      }
    }

    const disposeWatch = scope.watch((next) => { reconcile(next) })
    reconcile(scope.get())

    ctx.effect(() => () => {
      disposeWatch()
      stopTimer()
    })
  })

  registerTool(ctx, () => readConfig(), home)
}
