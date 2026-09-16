# OpenCode 2 CLIProxyAPI

[![CI](https://github.com/moutansos/opencode-cliproxyapi/actions/workflows/ci.yml/badge.svg)](https://github.com/moutansos/opencode-cliproxyapi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use every model exposed by [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
directly in [OpenCode V2](https://opencode.ai/v2/docs/).

This is the OpenCode V2 port of
[`opencode-cliproxyapi`](https://www.npmjs.com/package/opencode-cliproxyapi), which
targets OpenCode V1. The V1 plugin API does not run in V2, so this package is a
separate release built on `@opencode/plugin`.

The plugin discovers CLIProxyAPI's live `/v1/models` catalog whenever the plugin
loads, then registers them as a provider with `ctx.provider.transform`. Available
models appear in the normal `/models` picker under **CLIProxyAPI**. Model names,
capabilities, limits, and costs are enriched from live metadata on
[models.dev](https://models.dev/), and models that expose Anthropic-compatible
endpoints are routed through `/v1/messages`. No model IDs are hard-coded.

## Quick start

You need OpenCode V2, a running CLIProxyAPI server, and one of its API keys.

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

The URL may include `/v1`, but it is not required. If `baseURL` is omitted, the
plugin uses `http://localhost:8317/v1`.

Keep this global config private because it contains your API key. Do not copy
the connection into a project's `opencode.json` or commit it to a repository.

### 2. Select a model

Start OpenCode and run `/models`:

```bash
opencode
```

Choose **CLIProxyAPI**, select a model, and use OpenCode normally. Restart
OpenCode whenever the model catalog on CLIProxyAPI changes.

## Configuration

| Plugin option | Default | Purpose |
| --- | --- | --- |
| `baseURL` | `CLIPROXY_BASE_URL` or `http://localhost:8317/v1` | CLIProxyAPI URL |
| `apiKey` | `CLIPROXY_API_KEY` | CLIProxyAPI key |
| `providerID` | `cliproxyapi` | ID used in `provider/model` names |
| `providerName` | `CLIProxyAPI` | Name displayed in the model picker |
| `protocol` | `chat` | Default protocol: `chat` uses `/chat/completions`; `responses` uses `/responses`. Models marked as Anthropic-compatible by dynamic metadata override this per model. |
| `modelMetadataURL` | `https://models.dev/api.json` | Dynamic model metadata. Set to `false` to disable enrichment and use only inferred defaults. |
| `discoveryTimeoutMs` | `10000` | Startup model-discovery timeout |

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

Then check the plugin's own startup messages in the OpenCode server log:

```bash
grep cliproxyapi ~/.local/share/opencode/log/opencode.log
```

### Environment configuration works in one terminal but not another

OpenCode V2 runs a shared background service, so environment variables must be
available to that service rather than to one terminal. Move the connection into
the global OpenCode config, or export the variables from your shell profile and
restart the service with `opencode service restart`.

## Development

```bash
git clone https://github.com/moutansos/opencode-cliproxyapi.git
cd opencode-cliproxyapi
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
