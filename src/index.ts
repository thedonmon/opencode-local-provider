import type { PluginModule } from "@opencode-ai/plugin"

import { LocalProviderPlugin } from "./plugin"
import { LocalProviderPluginV2 } from "./v2"

export * from "./constants"
export * from "./plugin"
export * from "./probe"
export * from "./types"
export * from "./v2"

// OpenCode v2 reads `id` and `setup`; v1 (1.18.29+) calls `server`. The two
// implementations share probing and model building but not hooks.
const plugin = {
  ...LocalProviderPluginV2,
  server: LocalProviderPlugin,
} satisfies PluginModule

export default plugin
