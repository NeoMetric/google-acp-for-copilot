# Google ACP for Copilot

Use your Google Antigravity plan's models inside **GitHub Copilot Chat** in VS Code. The extension runs Google's own [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server locally, publishes its models to the Copilot model picker, and lets the agent use the tools of your chat.

It is the Google counterpart of Claude ACP for Copilot and shares its design.

## Which server runs

Google's official Antigravity ACP server (`agy_acp_server`, listed in the [ACP registry](https://agentclientprotocol.com/get-started/registry) as `antigravity-acp`). It works with a Google account that has an Antigravity / Google AI Pro or Ultra plan, or with a Gemini API key.

The extension downloads the server itself, once, from `dl.google.com` (about 130 MB, and only after you choose **Set Up**).

## Install

Install **Google ACP for Copilot** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=NeoMetric.google-acp-for-copilot), or search for `NeoMetric.google-acp-for-copilot` in the VS Code Extensions view. Updates arrive automatically through VS Code.

## Set up

1. Run **Google ACP: Set Up** from the Command Palette. It downloads the server and starts it.
2. Sign in. The server opens Google's sign-in page in your browser the first time and keeps the tokens itself. Or run **Google ACP: Set Gemini API Key** to use a key from Google AI Studio; it is kept in VS Code's secret storage and passed to the server as `GEMINI_API_KEY`.
3. Open Copilot Chat and pick a model under **Google Agent**.

The server takes a while to start (about 10 to 30 seconds, depending on the machine).

## Your account

Google's [Antigravity terms](https://antigravity.google/terms) do not allow third-party software that reuses its credentials. This extension runs Google's official binary unmodified and never sees your tokens, since sign-in stays inside the server. Use it for your own account and your own work, never as a shared service. A Gemini API key avoids the question.

## Commands

| Command | What it does |
|---|---|
| Google ACP: Set Up (Download Antigravity Server) | Downloads the server if needed, starts it, and asks Copilot to list its models |
| Google ACP: Sign In (Google Account or API Key) | Browser sign-in, or save a Gemini API key |
| Google ACP: Set / Remove Gemini API Key | Manage the saved key |
| Google ACP: Choose Which Credentials to Use | Saved key or signed-in account |
| Google ACP: Restart Agent | Restart the server process |
| Google ACP: Show Agent and Credentials | Shows what runs and which credentials it has |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `googleAcp.agent.command` | empty | Program to start instead of the downloaded Antigravity server |
| `googleAcp.agent.args` | empty | Arguments for that program; empty means none |
| `googleAcp.permissionMode` | `auto` | `auto` approves the agent's own permission requests, `ask` shows the options |
| `googleAcp.authPreference` | `auto` | `auto`, `apiKey` or `oauth` (ignore `GEMINI_API_KEY` and the saved key) |

| `googleAcp.useAgentBuiltInTools` | `false` | Let the agent use its own file, shell and search tools. Off by default: the extension asks Antigravity not to use them and declines their permission requests, so your Copilot chat's tools do the work |

Changing the command or arguments restarts the agent.

## How it works

Copilot Chat calls the extension's language model provider. The extension starts the ACP server as a child process rooted in your workspace folder, creates one ACP session per chat, and streams the reply back. Copilot's own tools are offered to the agent through a local MCP bridge, so file edits and terminal commands still go through Copilot's confirmations.

A tool call ends the response so Copilot can run the tool, and the next request carrying its result continues the same turn. A call the agent makes while Copilot is still running another is held for that next response rather than failed, and stopping the chat cancels the agent's turn even after a tool call was handed over.

## Skills and customizations

Skills (folders with a `SKILL.md` in `.copilot/skills`, `.claude/skills`, `.agents/skills`, `.github/skills`, or directories configured in `chat.agentSkillsLocations`), workspace instructions (`.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `.instructions.md`), custom agents (`.agent.md`), and prompt files (`.prompt.md`) are automatically discovered and included in the session's system prompt so Google Antigravity can use them.

## What is not included

- **No usage meter.** The Claude version shows plan limits in the status bar; the Google servers do not report plan usage over ACP.
- **No integrity check on the download.** The ACP registry publishes no checksums, so the extension pins the version and URL, requires HTTPS, and checks the download size.

## Privacy

The extension collects no telemetry. Your prompts go only to the Google ACP server it launches on your machine, which talks to Google under your own account. On first use the extension downloads that server from `https://dl.google.com/agy-extensions/releases`; nothing else is fetched. The local MCP bridge listens on `127.0.0.1` only and requires a per-session token.

## Development

```
npm install
npm run compile    # typecheck and bundle to dist/
npm test           # unit tests (vitest)
npm run lint
npm run package    # build a .vsix with vsce
```

Press F5 in VS Code to launch an Extension Development Host. Unofficial; not affiliated with Google. Antigravity and Gemini are trademarks of Google LLC.

## License

MIT
