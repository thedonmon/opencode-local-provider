# *opencode-local-provider* OpenCode Plugin

> Fork of [goniz/opencode-local-provider](https://github.com/goniz/opencode-local-provider), published as `@0xdon0/opencode-local-provider`. It adds optional per-server API keys, adding servers from `/connect`, listing every llama-swap model, and a fallback for any OpenAI-compatible server. Don't install it alongside the original package.

OpenCode plugin that adds a single `local` provider with runtime model detection for local OpenAI-compatible servers.

It currently supports the following local backends:
- Ollama
- LM Studio
- llama.cpp server
- vLLM
- Exo
- llama-swap
- oMLX
- MLX-VLM
- Any other server with an OpenAI-compatible `/v1/models` endpoint (`openai`, used when nothing more specific matches)

Instead of creating one provider per server, this plugin keeps one `local` provider and lets you register multiple named targets. Each target is probed at runtime, and its models are exposed automatically.

## Features

- Adds a `local` provider to OpenCode
- Supports multiple servers under one provider
- Includes supported default `127.0.0.1` targets automatically
- Detects models at runtime and fills in context size, tool calling, and vision support where the server reports them
- Routes each model to the correct target URL
- Optional API key per target, sent as `Authorization: Bearer <key>`
- Uses OpenCode global config, not project-local config

## Example

https://github.com/user-attachments/assets/8693fd22-c311-4cb4-913b-93d5a531b23c

## Install

```bash
opencode plugin --global @0xdon0/opencode-local-provider
```

OpenCode will install the package and update the config for you.

## Provider Setup

Default targets are enabled automatically for these backends and ports:

- Ollama: `http://127.0.0.1:11434`
- LM Studio: `http://127.0.0.1:1234`
- llama.cpp: `http://127.0.0.1:8080`
- vLLM: `http://127.0.0.1:8000`
- Exo: `http://127.0.0.1:52415`
- llama-swap: `http://127.0.0.1:8080`
- oMLX: `http://127.0.0.1:8000`
- MLX-VLM: `http://127.0.0.1:8080`

If your local servers run on these ports and do not need an API key, you can start using the `local` provider immediately.

**Note: oMLX with API authentication enabled needs a custom target with its API key set (see below).**

## Custom Targets

Add a server on another host or port, or one that needs an API key, with **Add Custom Target**. Run it from the TUI with `/connect` → **Local LLM Provider**, or from the CLI:

```bash
opencode auth login --provider local --method "Add Custom Target"
```

It asks for:

- a target ID, like `studio` or `remote-ollama`
- the server URL, with or without `/v1`
- the server's API key. Leave it empty if the server has none. Enter `{env:VAR_NAME}` to store a reference to an environment variable instead of the key itself
- which models to list: only loaded models, or every model the server offers (useful for llama-swap, which loads models on demand)

The plugin checks that the server answers before it saves anything, then adds the target to your OpenCode global config. Run it again to add more servers.

`/connect` only lists **Local LLM Provider** once the provider has at least one model. If none of your servers are reachable yet, add the first target from the CLI.

You can also add targets manually in config:

```json
{
  "provider": {
    "local": {
      "options": {
        "includeDefaults": true,
        "targets": {
          "studio": {
            "url": "http://192.168.1.10:1234/v1",
            "kind": "lmstudio"
          },
          "swap": {
            "url": "https://llama-swap.example.com/v1",
            "kind": "llamaswap",
            "apiKey": "{env:LLAMA_SWAP_API_KEY}",
            "includeUnloaded": true
          }
        }
      }
    }
  }
}
```

Target fields:

- `url` (required): the server URL
- `kind` (optional): one of `ollama`, `lmstudio`, `llamacpp`, `vllm`, `exo`, `llamaswap`, `omlx`, `mlxvlm`, `openai`. If you leave it out, the backend is detected. `openai` treats any server as a plain OpenAI-compatible endpoint
- `apiKey` (optional): sent as `Authorization: Bearer <key>` when probing the server and with every chat request to its models. Use `{env:VAR_NAME}` to keep the key out of the config file
- `includeUnloaded` (optional, llama-swap only): list every model llama-swap offers, not only the loaded ones. The plugin reads their details from `/v1/models` and does not load them

Explicit targets override the built-in defaults when they use the same ID. A key set in `provider.local.options.apiKey` applies to every target that has no `apiKey` of its own.

With `includeDefaults: true`, the built-in default `127.0.0.1` targets are also checked at runtime even though they are not written into config. Set it to `false` if you only use custom targets.

## OpenCode v2

The same package works with OpenCode v2. Setup differs in three places:

- **Adding a server:** run `/connect` → **Local LLM Servers** → **Add Custom Target**. It asks the same questions and checks the server the same way. Each target is saved as one of that integration's connections, with its API key kept in OpenCode's credential store, so you remove a target by removing its connection there.
- **Config targets:** v2 has no `provider.local.options`. Put `targets`, `includeDefaults` and a shared `apiKey` in the plugin's own entry instead:

  ```json
  {
    "plugins": [
      {
        "package": "@0xdon0/opencode-local-provider",
        "options": {
          "includeDefaults": true,
          "targets": {
            "studio": { "url": "http://192.168.1.10:1234/v1", "kind": "lmstudio" }
          }
        }
      }
    ]
  }
  ```

- **Refreshing:** the plugin probes again every minute and whenever a target is added or removed, so you don't need to restart OpenCode to see newly loaded models. Remembered llama-swap context sizes are kept in the plugin's own storage instead of `~/.cache`.

Model overrides use v2's `provider.local.models` config, which OpenCode applies on top of what the plugin detected. Don't add a key to the `local` provider itself in v2: OpenCode would send it to every target in place of each target's own key.

## How Models Appear

Models are discovered dynamically from each configured target. By default, only **loaded** models are listed.

To avoid collisions, model IDs are prefixed with the target ID:

- `ollama/llama3.2`
- `studio/qwen2.5-coder`

Each generated model keeps its own target URL and API key internally, so requests go to the correct backend.

Models that don't chat in text, such as speech-to-text, rerankers, or embeddings, are skipped when the server's listing says so.

## Context Size and Model Settings

OpenCode compacts a conversation once it nears the model's context size, so each model needs the right one. The plugin uses the first of these that it finds:

1. Settings for the model in your OpenCode config (see below)
2. What the running server reports: llama.cpp, or a llama-swap model that is currently loaded
3. The server's `/v1/models` listing (`context_length`, `context_window`, `max_model_len` or `meta.n_ctx`)
4. What a llama-swap model reported the last time it was loaded when OpenCode started. These values are kept in `~/.cache/opencode-local-provider/models.json`
5. 32,768 tokens

The output limit is a quarter of the context, capped at 32,000 tokens. Sizes are read when OpenCode starts, so restart it to pick up changes.

### llama-swap servers

llama-swap only reports a model's context size while the model is loaded. To advertise every model's size, the server admin can add a `capabilities` block to each model in the llama-swap config (v225 or later). The listing then includes the context size, tool support and input types:

```yaml
models:
  qwen3.6-35b-a3b:
    cmd: llama-server --port ${PORT} -m /models/Qwen3.6-35B-A3B.gguf --mmproj /models/mmproj.gguf -c 262144
    capabilities:
      context: 262144 # the -c value from cmd
      tools: true
      in: [text, image] # image only when cmd loads an --mmproj
      out: [text]
  whisper:
    cmd: whisper-server --port ${PORT} -m /models/ggml-large-v3.bin
    capabilities:
      in: [audio] # not a chat model, so the plugin skips it
      out: [text]
```

Set `context` to the `-c` value in `cmd`. Without `-c`, llama-server chooses the size when it loads the model, and may reduce it to fit in memory.

### Overriding a model

Settings under `provider.local.models`, keyed by `<target>/<model>`, replace what the plugin detected:

```json
{
  "provider": {
    "local": {
      "models": {
        "swap/qwen3.6-35b-a3b": {
          "limit": { "context": 262144, "output": 32000 },
          "modalities": { "input": ["text", "image"] }
        }
      }
    }
  }
}
```

This works for any OpenCode model field, such as `name`, `limit`, `modalities`, `attachment`, `tool_call`, `reasoning`, `options` or `variants`. OpenCode requires both `context` and `output` when `limit` is set.

## Notes

- Model detection is runtime-based, not static
- If loaded models change in your local server, OpenCode will see the updated list on the next provider refresh
- Built-in default `127.0.0.1` targets are enabled unless you set `includeDefaults` to `false`
- If a custom target cannot be probed, the reason (for example `HTTP 401` for a wrong key) is written to the OpenCode log

## Development

Build the plugin:

```bash
bun run build
```

Run the provider integration suite:

```bash
bun run test:providers
```

Run a single provider suite:

```bash
PROVIDER_SUITE=ollama bun run test:providers
```

Notes:

- The suite starts provider containers for `ollama`, `lmstudio`, `llamacpp`, `vllm`, `exo`, `llamaswap`, `omlx`, and `mlxvlm` from `tests/docker/compose.providers.yml`.
- The Bun test runner talks to each service over the Docker Compose network using each container's internal IP. It does not require publishing ports to the host.
- The first run can be slow because the containers may need to download model assets, LM Studio bootstraps its headless runtime at startup, and Exo warms models to a real ready state before the suite proceeds.
- CI runs the same suite per provider via `.github/workflows/provider-tests.yml`.
- If you change provider models or startup behavior, update `tests/docker/compose.providers.yml` and the Bun orchestration helpers in `tests/docker/` instead of duplicating those details here.

Install it locally in OpenCode with a file path plugin entry, for example:

```bash
opencode plugin $PWD
```

## License

MIT
