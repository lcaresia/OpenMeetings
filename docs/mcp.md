# MCP

Open Meetings speaks MCP in both directions.

## As a client: give the agent more tools

Add MCP servers (stdio) to the config. Their tools join the built-in ones, so someone in the
meeting can say "open meetings, create a Linear issue for the login bug".

```yaml
mcp:
  servers:
    - name: linear
      command: npx
      args: ["-y", "<linear-mcp-package>"]
      env: { LINEAR_API_KEY: "${LINEAR_API_KEY}" }
    - name: github
      command: docker
      args:
        [
          "run",
          "-i",
          "--rm",
          "-e",
          "GITHUB_PERSONAL_ACCESS_TOKEN",
          "ghcr.io/github/github-mcp-server",
        ]
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
      autoApprove: ["get_issue", "search_issues"]
```

- Tools appear to the model as `<server>__<tool>`.
- A tool with side effects asks for confirmation in the call chat (`om sim` / `om não`) and on
  the panel before it runs. Tools the server marks `readOnlyHint`, or listed in `autoApprove`,
  run directly. `"*"` approves every tool of that server.
- A server that fails to start is logged and skipped; the others keep working.
- Server processes start with the Open Meetings server and stop with it.

Use the package names from each MCP server's own documentation; this file does not vouch for
any specific third-party server.

## As a server: let other hosts use Open Meetings

`POST /mcp` is a remote MCP server (Streamable HTTP, stateless, same token as the API). Tools:
`join_meeting`, `list_meetings`, `get_meeting`, `ask_meeting`, `search_meetings`,
`leave_meeting`. This is how OpenDots Dots use Open Meetings
([integrations/opendots.md](integrations/opendots.md)); any MCP host works the same way.
