import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { LocalModel } from "./types"

type Seen = Pick<LocalModel, "context" | "toolcall" | "vision">

// Server URL -> model ID -> what the running server last reported.
export type ModelCache = Record<string, Record<string, Seen>>

function cachePath() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-local-provider", "models.json")
}

function isSeen(value: unknown): value is Seen {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return typeof item.context === "number" && typeof item.toolcall === "boolean" && typeof item.vision === "boolean"
}

export async function loadModelCache(): Promise<ModelCache> {
  try {
    const data = JSON.parse(await readFile(cachePath(), "utf8"))
    return data && typeof data === "object" && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

// The cache only saves a round of guessing, so failing to write it is fine.
export async function saveModelCache(cache: ModelCache) {
  const file = cachePath()
  const temp = `${file}.${process.pid}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temp, JSON.stringify(cache, null, 2) + "\n")
    await rename(temp, file)
  } catch {}
}

// llama-swap only reports a model's context size while the model is loaded.
// Record what loaded models report, and give models that are swapped out the
// values they had last time instead of the defaults.
export function rememberModels(cache: ModelCache, url: string, models: LocalModel[]) {
  let changed = false
  const next = models.map(({ live, ...model }) => {
    const seen = cache[url]?.[model.id]
    if (live) {
      const now = { context: model.context, toolcall: model.toolcall, vision: model.vision }
      if (JSON.stringify(seen) !== JSON.stringify(now)) {
        cache[url] = { ...cache[url], [model.id]: now }
        changed = true
      }
      return model
    }
    if (!isSeen(seen)) return model
    return {
      ...model,
      context: model.context || seen.context,
      toolcall: model.toolcall || seen.toolcall,
      vision: model.vision || seen.vision,
    }
  })
  return { models: next, changed }
}
