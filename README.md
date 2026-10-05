# OpenCode 2 CLIProxyAPI

[![CI](https://github.com/moutansos/opencode2-cliproxyapi/actions/workflows/ci.yml/badge.svg)](https://github.com/moutansos/opencode2-cliproxyapi/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode2-cliproxyapi.svg)](https://www.npmjs.com/package/opencode2-cliproxyapi)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use every model exposed by [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
directly in [OpenCode V2](https://opencode.ai/v2/docs/).

This is the OpenCode V2 port of
[`opencode-cliproxyapi`](https://www.npmjs.com/package/opencode-cliproxyapi), which
targets OpenCode V1. The V1 plugin API does not run in V2, so this package is a
separate release built on `@opencode/plugin`.

The plugin discovers CLIProxyAPI's live `/v1/models` catalog whenever it loads
(and refreshes it in the background), then registers them as a provider with
`ctx.provider.transform`. Available models appear in the normal `/models`
picker under **CLIProxyAPI**. Model names, capabilities, limits, costs, and
reasoning variants are enriched from live metadata on
[models.dev](https://models.dev/). Deployment limits that the CLIProxyAPI server
itself reports take precedence (see
[Live model metadata](#live-model-metadata)). No model IDs are hard-coded.

Claude models owned by Anthropic use OpenCode's Anthropic Messages runtime
against CLIProxyAPI's `/v1/messages` endpoint, including thinking/effort
variants. Everything else uses OpenAI-compatible `/v1/chat/completions` (or
`/v1/responses` when `protocol` is `responses`).

## Quick start

You need OpenCode 2.0.4 or newer, a running CLIProxyAPI server, and one of its
API keys. Earlier 2.0 releases do not expose the provider registry the plugin
registers into, and it stops with a warning instead of adding models.

### 1. Configure the plugin

Open your global OpenCode config:

```text
~/.config/opencode/opencode.json
```

`opencode.jsonc` works too. Add the plugin with your server URL and API key:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode2-cliproxyapi",
      "options": {
        "baseURL": "http://your-server:8317",
        "apiKey": "your-cli-proxy-api-key"
      }
    }
  ]
}
```

`package` can be pinned to a specific release, such as
`"opencode2-cliproxyapi@0.2.2"`. Omitting the version tracks the latest
release.

The URL may include `/v1`, but it is not required. If `baseURL` is omitted, the
plugin uses `http://localhost:8317/v1`.

Keep this global config private because it contains your API key. Do not copy
the connection into a project's `opencode.json` or commit it to a repository.

### 2. Select a model

Start OpenCode and run `/models`:

```bash
opencode
```

Choose **CLIProxyAPI**, select a model, and use OpenCode normally. The plugin
refreshes the catalog every five minutes; you can also restart OpenCode to
pick up changes immediately.

## Configuration

| Plugin option | Default | Purpose |
| --- | --- | --- |
| `baseURL` | `CLIPROXY_BASE_URL` or `http://localhost:8317/v1` | CLIProxyAPI URL |
| `apiKey` | `CLIPROXY_API_KEY` | CLIProxyAPI key |
| `providerID` | `cliproxyapi` | ID used in `provider/model` names |
| `providerName` | `CLIProxyAPI` | Name displayed in the model picker |
| `protocol` | `chat` | Default protocol for non-Anthropic models: `chat` uses `/chat/completions`; `responses` uses `/responses`. Claude models still use `/v1/messages`. |
| `modelMetadataURL` | `https://models.dev/api.json` | Dynamic model metadata. Set to `false` to disable enrichment and use only inferred defaults. |
| `discoveryTimeoutMs` | `10000` | Startup model-discovery timeout |
| `refreshIntervalMs` | `300000` | Background catalog refresh interval. Set to `0` to refresh only at startup. |

If model metadata cannot be reached, the plugin logs a warning and keeps the
CLIProxyAPI-discovered models available with inferred capabilities and the
configured default protocol.

### Optional environment variables

Environment variables remain available for containers, CI, or users who prefer
not to place a key in the config:

```bash
export CLIPROXY_BASE_URL="http://your-server:8317"
export CLIPROXY_API_KEY="your-cli-proxy-api-key"
```

Put these lines in your shell profile if you want them to persist. Explicit
plugin options in `opencode.json` take precedence over environment variables.

### Live model metadata

A server can describe what a deployment actually provides by adding these
optional fields to `/v1/models` entries. The plugin reads only these fields; it
ignores unknown fields, and it ignores a malformed value without dropping the
model.

| `/v1/models` field | OpenCode field | Accepted values |
| --- | --- | --- |
| `context_length` | `limit.context` | Positive integer |
| `max_completion_tokens` | `limit.output` | Positive integer |
| `display_name` | `name` | Non-empty string |

```json
{
  "object": "list",
  "data": [
    {
      "id": "deployment-coder",
      "object": "model",
      "owned_by": "local-provider",
      "display_name": "Deployment Coder",
      "context_length": 8192,
      "max_completion_tokens": 2048
    }
  ]
}
```

Stock CLIProxyAPI returns only `id`, `object`, `created`, and `owned_by`. The
extra fields require server-side enrichment, such as a CLIProxyAPI plugin that
rewrites the model list. Without them, behavior is unchanged.

Each field is merged independently, from highest to lowest priority:

1. Your configuration under `providers.<providerID>.models`, which OpenCode
   layers on top of the plugin.
2. Live metadata from CLIProxyAPI.
3. The `modelMetadataURL` catalog (models.dev by default).
4. OpenCode defaults (`context` 200000, `output` 32000).

A live context wins even when it is smaller than the catalog value. Live
metadata applies even if the model is not in the catalog, if enrichment is
disabled (`modelMetadataURL: false`), or if the catalog cannot be fetched. Each
background refresh rebuilds the models from the latest response, so changed
values apply and removed fields fall back to the next source.

To keep budgets coherent when a live limit is present, the plugin also:

- never lets the output limit exceed the context;
- caps an inherited output budget at a quarter of a live `context_length` when
  the server sends no `max_completion_tokens`. For example, a live context of
  8192 with a catalog output of 32768 resolves to output 2048;
- caps an inherited input limit to context minus output.

### Customizing discovered models

The plugin registers a provider source. Anything you configure under
`providers.cliproxyapi` in `opencode.json` is layered on top of it, so
individual models can still be customized:

```json
{
  "providers": {
    "cliproxyapi": {
      "models": {
        "gpt-5.6-terra": {
          "name": "Terra",
          "limit": {
            "context": 200000,
            "output": 65536
          }
        }
      }
    }
  }
}
```

## Troubleshooting

### No CLIProxyAPI models appear

First check the API directly:

```bash
curl -H "Authorization: Bearer your-cli-proxy-api-key" \
  "http://your-server:8317/v1/models"
```

Then confirm the plugin itself loaded:

```bash
opencode plugin list
```

If it is missing, look for the reason in the OpenCode server log. The plugin's
own `console` output does not reach that file, so search for load failures
instead:

```bash
grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log
```

### A model fails with "unknown provider for model"

That error comes from CLIProxyAPI, not from OpenCode. The server advertises the
model in `/v1/models` but cannot route it, which happens when its upstream
accounts change. Confirm with a direct request:

```bash
curl -X POST -H "Authorization: Bearer your-cli-proxy-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"the-model-id","messages":[{"role":"user","content":"hi"}]}' \
  "http://your-server:8317/v1/chat/completions"
```

The plugin drops such models once it refreshes its catalog.

### Environment configuration works in one terminal but not another

OpenCode V2 runs a shared background service, so environment variables must be
available to that service rather than to one terminal. Move the connection into
the global OpenCode config, or export the variables from your shell profile and
restart the service with `opencode service restart`.

## Development

```bash
git clone https://github.com/moutansos/opencode2-cliproxyapi.git
cd opencode2-cliproxyapi
bun install
bun run check
```

The repository's `opencode.json` loads the local build for integration testing:

```bash
bun run build
export CLIPROXY_BASE_URL="http://your-server:8317"
export CLIPROXY_API_KEY="your-cli-proxy-api-key"
opencode
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Credits

Original OpenCode V1 plugin by [İbrahim BABAL](https://github.com/yourcasualdev)
at [yourcasualdev/opencode-cliproxyapi](https://github.com/yourcasualdev/opencode-cliproxyapi).

## License

[MIT](LICENSE)
