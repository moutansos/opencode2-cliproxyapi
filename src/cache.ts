import { createHash } from "node:crypto"
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { CatalogModel, ModelMetadataCatalog } from "./catalog.js"

const CACHE_VERSION = 1
const METADATA_TTL_MS = 6 * 60 * 60_000
const CATALOG_TTL_MS = 30_000
// Longer than one metadata request. discoveryTimeoutMs defaults to 10s, and a
// cold models.dev download can use most of that. A shorter stale window lets a
// second process steal the lock from a download that is still running.
export const LOCK_STALE_MS = 3 * 60_000

type CatalogCache = {
  version: number
  fetchedAt: number
  models: CatalogModel[]
}

type MetadataCache = {
  version: number
  fetchedAt: number
  catalog: ModelMetadataCatalog
}

export function cacheRoot() {
  return (
    process.env.CLIPROXYAPI_CACHE_DIR ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode2-cliproxyapi")
  )
}

function cacheKey(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function catalogPath(key: string, root: string) {
  return join(root, `catalog-${cacheKey(key)}.json`)
}

function metadataPath(url: string, root: string) {
  return join(root, `metadata-${cacheKey(url)}.json`)
}

function lockPath(name: string, root: string) {
  return join(root, `${name}.lock`)
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, JSON.stringify(value))
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCatalogModel(value: unknown): value is CatalogModel {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === "") return false
  if (value.ownedBy !== undefined && typeof value.ownedBy !== "string") return false
  if (value.live === undefined) return true
  if (!isRecord(value.live)) return false

  const live = value.live
  if (live.name !== undefined && typeof live.name !== "string") return false
  if (live.limit === undefined) return true
  if (!isRecord(live.limit)) return false
  const limit = live.limit
  return (
    (limit.context === undefined || typeof limit.context === "number") &&
    (limit.output === undefined || typeof limit.output === "number")
  )
}

export async function readCatalogCache(
  key: string,
  root = cacheRoot(),
): Promise<{ models: CatalogModel[]; fetchedAt: number } | undefined> {
  const value = await readJson(catalogPath(key, root))
  if (!isRecord(value) || value.version !== CACHE_VERSION) return
  if (!Array.isArray(value.models) || !value.models.every(isCatalogModel)) return
  if (typeof value.fetchedAt !== "number") return

  return { models: value.models, fetchedAt: value.fetchedAt }
}

export async function writeCatalogCache(key: string, models: CatalogModel[], root = cacheRoot()) {
  const value: CatalogCache = {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    models,
  }
  await writeJson(catalogPath(key, root), value)
}

export async function readMetadataCache(
  url: string,
  root = cacheRoot(),
): Promise<{ catalog: ModelMetadataCatalog; fetchedAt: number } | undefined> {
  const value = await readJson(metadataPath(url, root))
  if (!isRecord(value) || value.version !== CACHE_VERSION) return
  if (!isRecord(value.catalog) || typeof value.fetchedAt !== "number") return

  return {
    catalog: value.catalog as ModelMetadataCatalog,
    fetchedAt: value.fetchedAt,
  }
}

export function metadataCacheIsFresh(fetchedAt: number, now = Date.now()) {
  return now - fetchedAt < METADATA_TTL_MS
}

export function catalogCacheIsFresh(fetchedAt: number, now = Date.now()) {
  return now - fetchedAt < CATALOG_TTL_MS
}

export async function writeMetadataCache(
  url: string,
  catalog: ModelMetadataCatalog,
  root = cacheRoot(),
) {
  const value: MetadataCache = {
    version: CACHE_VERSION,
    fetchedAt: Date.now(),
    catalog,
  }
  await writeJson(metadataPath(url, root), value)
}

async function tryAcquire(path: string): Promise<(() => Promise<void>) | undefined> {
  const token = `${process.pid}.${Date.now()}.${Math.random()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, "wx")
  } catch (error) {
    if (isErrno(error, "EEXIST")) return
    throw error
  }

  try {
    await handle.writeFile(token)
  } catch (error) {
    // This exclusive create belongs to this attempt. Remove it so a failed
    // write cannot leave a lock that no process will release.
    await unlink(path).catch(() => {})
    throw error
  } finally {
    await handle.close()
  }

  return async () => {
    // A stale lock may already have been taken over. Only the owner may remove it.
    const current = await readFile(path, "utf8").catch(() => undefined)
    if (current === token) await unlink(path).catch(() => {})
  }
}

function isErrno(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

/**
 * Allow only one plugin process to download the large metadata catalog at a
 * time. OpenCode may load this plugin in a separate process for every location,
 * so an in-memory promise is not enough to stop a download stampede.
 *
 * Returns undefined when another live process holds the lock. Throws when the
 * lock directory itself cannot be created, so the caller can fall back to an
 * uncoordinated download instead of skipping metadata entirely.
 */
export async function acquireMetadataLock(
  url: string,
  root = cacheRoot(),
): Promise<(() => Promise<void>) | undefined> {
  const path = lockPath(`metadata-${cacheKey(url)}`, root)
  await mkdir(root, { recursive: true })

  const first = await tryAcquire(path)
  if (first) return first

  // Recover a lock left behind by a crashed plugin process. A lock younger
  // than LOCK_STALE_MS is still owned by a live download.
  let stale = false
  try {
    const info = await stat(path)
    stale = Date.now() - info.mtimeMs > LOCK_STALE_MS
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error
    stale = true
  }

  if (!stale) return

  await unlink(path).catch((error) => {
    if (!isErrno(error, "ENOENT")) throw error
  })
  return tryAcquire(path)
}

export const cacheInternals = {
  cacheKey,
  catalogPath,
  metadataPath,
  lockPath,
  writeJson,
}
