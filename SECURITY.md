# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities through a public issue.

Use the repository's
[private vulnerability reporting](https://github.com/moutansos/opencode2-cliproxyapi/security/advisories/new)
page instead.

Include reproduction steps, affected versions, and the expected security
impact. You should receive an acknowledgement within seven days.

## Credential handling

Store persistent connection details only in OpenCode's global user config, not
in a project's `opencode.json`. Restrict that global config to the current user
when it contains an API key.

The plugin also supports `CLIPROXY_API_KEY` for environments where secrets are
injected at runtime. Never commit CLIProxyAPI keys to a repository.
