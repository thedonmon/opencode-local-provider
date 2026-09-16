# *opencode-local-provider* OpenCode Plugin

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
opencode plugin --global opencode-local-provider
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

## How Models Appear

Models are discovered dynamically from each configured target. By default, only **loaded** models are listed.

To avoid collisions, model IDs are prefixed with the target ID:

- `ollama/llama3.2`
- `studio/qwen2.5-coder`

Each generated model keeps its own target URL and API key internally, so requests go to the correct backend.

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
