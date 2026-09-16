import type { LocalProviderKind, LocalTarget } from "./types"

import { supportedProviders, supportedProviderKinds } from "./providers"
import { authHeaders, rootURL } from "./url"

export type ProbeTarget = Pick<LocalTarget, "apiKey" | "includeUnloaded">

export async function detect(url: string, apiKey?: string): Promise<LocalProviderKind | null> {
  const root = rootURL(url)
  const headers = authHeaders(apiKey)

  for (const kind of supportedProviderKinds) {
    if (await supportedProviders[kind].detect(root, headers)) return kind
  }

  return null
}

// Every detector swallows errors, so a rejected key looks like an unknown
// server. Check once more to tell the two apart in the error.
async function notDetected(url: string, root: string, headers: Record<string, string>) {
  const status = await fetch(root + "/v1/models", {
    headers,
    signal: AbortSignal.timeout(1000),
  }).then(
    (res) => res.status,
    () => undefined,
  )
  if (status === 401 || status === 403) {
    return new Error(`${url} rejected the request (HTTP ${status}), check the target's API key`)
  }
  return new Error(`No supported local provider detected at: ${url}`)
}

export async function probe(url: string, kind?: LocalProviderKind, target: ProbeTarget = {}) {
  const root = rootURL(url)
  const headers = authHeaders(target.apiKey)
  // Every backend also matches the generic "openai" kind, so asking for it
  // explicitly skips detection of the specific backends.
  const detected =
    kind === "openai"
      ? (await supportedProviders.openai.detect(root, headers)) ? kind : null
      : await detect(root, target.apiKey)

  if (!detected) throw await notDetected(url, root, headers)

  if (kind && detected !== kind) {
    throw new Error(`Expected ${kind} at ${url} but detected ${detected}`)
  }

  return {
    kind: detected,
    models: await supportedProviders[detected].probe(root, headers, { url, ...target }),
  }
}
