import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  acquireMetadataLock,
  cacheInternals,
  catalogCacheIsFresh,
  LOCK_STALE_MS,
  metadataCacheIsFresh,
  readCatalogCache,
  readMetadataCache,
  writeCatalogCache,
  writeMetadataCache,
} from "./cache.js"

async function root() {
  return mkdtemp(join(tmpdir(), "cliproxyapi-cache-"))
}

describe("disk cache", () => {
  test("round-trips the model catalog and metadata", async () => {
    const directory = await root()
    await writeCatalogCache("http://cliproxy.test/v1", [{ id: "chat-model" }], directory)
    await writeMetadataCache(
      "https://models.dev/api.json",
      { chat: { models: { "chat-model": { name: "Chat Model" } } } },
      directory,
    )

    expect(await readCatalogCache("http://cliproxy.test/v1", directory)).toMatchObject({
      models: [{ id: "chat-model" }],
    })
    const metadata = await readMetadataCache("https://models.dev/api.json", directory)
    expect(metadata?.catalog.chat?.models["chat-model"]?.name).toBe("Chat Model")
    expect(metadataCacheIsFresh(metadata?.fetchedAt ?? 0)).toBe(true)
    expect(catalogCacheIsFresh(Date.now())).toBe(true)
    expect(catalogCacheIsFresh(Date.now() - 31_000)).toBe(false)
    expect(metadataCacheIsFresh(Date.now() - 7 * 60 * 60_000)).toBe(false)
  })

  test("lets only one process hold the metadata lock", async () => {
    const directory = await root()
    const first = await acquireMetadataLock("https://models.dev/api.json", directory)
    const second = await acquireMetadataLock("https://models.dev/api.json", directory)

    expect(first).toBeFunction()
    expect(second).toBeUndefined()

    await first?.()
    const third = await acquireMetadataLock("https://models.dev/api.json", directory)
    expect(third).toBeFunction()
    await third?.()
  })

  test("ignores a malformed cache file", async () => {
    const directory = await root()
    await Bun.write(join(directory, "not-used.json"), "{")
    expect(await readCatalogCache("missing", directory)).toBeUndefined()
    expect(await readMetadataCache("missing", directory)).toBeUndefined()
  })

  test("rejects a catalog entry that is missing a model id", async () => {
    const directory = await root()
    const path = cacheInternals.catalogPath("http://cliproxy.test/v1", directory)
    await mkdir(directory, { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: [{ ownedBy: "acme" }, { id: "" }],
      }),
    )

    expect(await readCatalogCache("http://cliproxy.test/v1", directory)).toBeUndefined()
  })

  test("removes a temporary file when replacing the cache fails", async () => {
    const directory = await root()
    const path = join(directory, "nested", "catalog.json")
    await mkdir(path, { recursive: true })

    await expect(cacheInternals.writeJson(path, { ok: false })).rejects.toThrow()
    const entries = await Array.fromAsync(
      new Bun.Glob("*.tmp").scan({ cwd: join(directory, "nested") }),
    )
    expect(entries).toEqual([])
  })

  test("replaces a stale metadata lock and leaves a live lock alone", async () => {
    const directory = await root()
    const url = "https://models.dev/api.json"
    const path = cacheInternals.lockPath(`metadata-${cacheInternals.cacheKey(url)}`, directory)
    await mkdir(directory, { recursive: true })
    await writeFile(path, "stale")
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1_000)
    await utimes(path, stale, stale)

    const recovered = await acquireMetadataLock(url, directory)
    expect(recovered).toBeFunction()
    expect(await readFile(path, "utf8")).not.toBe("stale")

    const blocked = await acquireMetadataLock(url, directory)
    expect(blocked).toBeUndefined()
    const age = Date.now() - (await stat(path)).mtimeMs
    expect(age).toBeLessThan(LOCK_STALE_MS)

    await recovered?.()
    expect(await readFile(path, "utf8").catch(() => undefined)).toBeUndefined()
  })

  test("does not delete a lock that another process has taken over", async () => {
    const directory = await root()
    const url = "https://models.dev/api.json"
    const path = cacheInternals.lockPath(`metadata-${cacheInternals.cacheKey(url)}`, directory)
    await mkdir(directory, { recursive: true })
    await writeFile(path, "previous")
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1_000)
    await utimes(path, stale, stale)

    const recovered = await acquireMetadataLock(url, directory)
    await writeFile(path, "taken-over")
    await recovered?.()

    expect(await readFile(path, "utf8")).toBe("taken-over")
  })
})
