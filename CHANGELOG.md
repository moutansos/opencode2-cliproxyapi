# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-16

Initial release of `opencode2-cliproxyapi`, the OpenCode V2 port of
[`opencode-cliproxyapi`](https://www.npmjs.com/package/opencode-cliproxyapi)
`0.1.2`. The V1 plugin API does not run in V2, so this is a separate package.

### Changed

- Ported the plugin entrypoint from the V1 `Plugin` function and `config` hook
  to `Plugin.define` with a `setup` function built on `@opencode/plugin`.
- Registered the CLIProxyAPI provider and its discovered models through
  `ctx.provider.transform` instead of mutating OpenCode's config object.
- Replaced V1 `npm` provider packages with V2 native provider packages:
  `@opencode/ai/providers/openai-compatible`,
  `@opencode/ai/providers/openai-compatible/responses`, and
  `@opencode/ai/providers/anthropic-compatible` for Anthropic-compatible models.
- Replaced V1 model fields (`tool_call`, `modalities`, `attachment`) with the V2
  `Model.Info` shape (`capabilities`, `limit`, `cost`, `time`, `family`).
- Read plugin options from `ctx.options`, and log through the plugin process
  instead of `client.app.log`.

### Added

- Model names, families, context and output limits, token costs, and release
  dates from live models.dev metadata, rather than protocol metadata alone.

### Removed

- Manual merging of existing `provider.cliproxyapi` config. V2 layers user
  configuration over registered provider sources automatically.

[Unreleased]: https://github.com/moutansos/opencode2-cliproxyapi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/moutansos/opencode2-cliproxyapi/releases/tag/v0.1.0
