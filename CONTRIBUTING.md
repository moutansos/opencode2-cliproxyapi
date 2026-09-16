# Contributing

Contributions are welcome.

## Development

Requirements:

- Bun 1.3 or newer
- OpenCode 2.0 or newer for manual integration testing

Set up the project:

```bash
git clone https://github.com/moutansos/opencode2-cliproxyapi.git
cd opencode2-cliproxyapi
bun install
bun run check
```

## Pull requests

1. Keep changes focused.
2. Add or update tests for behavior changes.
3. Run `bun run check`.
4. Never commit API keys, credentials, or private server details.
5. Explain user-visible changes in the pull request.

For substantial behavior changes, open an issue first so the approach can be
discussed.

## Releases

1. Bump `version` in `package.json`.
2. Roll the `Unreleased` section of `CHANGELOG.md` into the new version and
   update the link definitions at the bottom of the file.
3. Tag the release commit `vX.Y.Z` and push the tag.
4. Publish a GitHub release for that tag. That triggers the npm publish
   workflow, which publishes through npm trusted publishing.

The tag must match the `package.json` version exactly. The workflow verifies
`vX.Y.Z` against the package version and fails the publish if they differ.

