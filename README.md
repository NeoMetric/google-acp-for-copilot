# Google ACP for Copilot

**Use the models of your Google Antigravity plan in GitHub Copilot Chat.** Sign in once with your Google account and get Antigravity in the model picker with everything Copilot offers: agent mode, tools, approvals, diffs, skills, custom agents and instruction files. Prefer pay-as-you-go? You can optionally use a Gemini API key instead.

- **Your plan, no extra subscription.** Sign in with the account that has your Antigravity, Google AI Pro or Ultra plan. Usage counts against your plan's limits.
- **Full Copilot experience.** Copilot keeps the agent loop and tools; Antigravity is the model driving them.
- **API keys are optional.** Save a Gemini API key from Google AI Studio if you would rather pay per token.
- **Told when your plan runs out.** When Antigravity refuses a request for using up your plan, a status bar warning says so, with the time the limit lifts when the server gives one.
- **Built for daily use.** **Thinking Effort** levels where the model offers them, streaming, cancellation, image attachments and token usage.

Under the hood, the extension runs Google's official Antigravity ACP server (`agy_acp_server`, listed in the [ACP registry](https://agentclientprotocol.com/get-started/registry) as `antigravity-acp`) as a local process, and downloads it once from `dl.google.com`.

> **Unofficial.** Not affiliated with Google or GitHub. "Antigravity", "Gemini" and "GitHub Copilot" are trademarks of their owners.
>
> **Your account.** Google's [Antigravity terms](https://antigravity.google/terms) do not allow third-party software that reuses its credentials. This extension runs Google's official binary unmodified and keeps sign-in inside it, so it never sees your tokens. Use it for your own account and your own work, never as a shared service. A Gemini API key avoids the question.

## Requirements

- VS Code 1.105 or newer with GitHub Copilot Chat, in a trusted workspace (not Restricted Mode or a virtual workspace).
- A Google account with an Antigravity, Google AI Pro or Ultra plan, or a Gemini API key.
- Windows (x64 or arm64), macOS (arm64 or x64) or Linux (x64 or arm64), and network access to `dl.google.com` for the one download. Nothing is installed globally.

## Getting started

1. Run **Google ACP: Set Up**, or accept the prompt after installing. It downloads the server (about 125 MB) and starts it; a start takes 10 to 30 seconds, depending on the machine.
2. Run **Google ACP: Sign In** if you are not signed in: the server opens Google's sign-in page in your browser, or you save a Gemini API key.
3. In Copilot Chat, pick a model under **Google Agent**.

Logs go to the **Google ACP** output channel. At the default Info level every request is named with its model, the message count and the tools sent with it, and a chat session is logged when it opens and when it closes. Set the level to Debug to also see tool titles and permission requests.

## Signing in

| Method | Billing |
| --- | --- |
| Google account (browser sign-in run by the ACP server) | Your Antigravity plan, with the limits Google sets |
| Gemini API key (saved in the OS keychain, handed to the server as `GEMINI_API_KEY`) | Per token, against the key's project |

- By default (`googleAcp.authPreference` = `auto`), a saved key beats a signed-in account, and beats a `GEMINI_API_KEY` or `GOOGLE_API_KEY` set in the environment VS Code starts from. `oauth` withholds all of them and keeps the account.
- Saving or removing a key restarts the agent. Choosing a browser sign-in while a key is saved asks whether to remove the key.
- Sign-in happens inside the server: the browser flow is Google's, and the tokens it stores never reach the extension.

## Commands

| Command | What it does |
| --- | --- |
| `Google ACP: Set Up (Download Antigravity Server)` | Downloads the server if needed, starts it, refreshes models |
| `Google ACP: Sign In (Google Account or API Key)` | Runs the chosen sign-in method |
| `Google ACP: Set Gemini API Key` | Saves a key and restarts the agent |
| `Google ACP: Choose Which Credentials to Use` | Picks between the saved key, the signed-in account, or automatic |
| `Google ACP: Remove Gemini API Key` | Deletes the saved key; the signed-in account is used instead |
| `Google ACP: Restart Agent` | Restarts the server process |
| `Google ACP: Show Agent and Credentials` | Shows which program runs and which credentials it has |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `googleAcp.agent.command` | empty | Program to start instead of the downloaded Antigravity server. Changing it restarts the agent. Machine-scoped. |
| `googleAcp.agent.args` | empty | Arguments for that program; empty means none. Changing them restarts the agent. Machine-scoped. |
| `googleAcp.permissionMode` | `auto` | `auto` approves the permission requests the agent makes. `ask` shows the options it offers; no answer within five minutes declines. Copilot's own confirmations apply to its tools either way. Machine-scoped. |
| `googleAcp.useAgentBuiltInTools` | `false` | Lets the agent use its own file, shell and search tools. Off by default, the extension asks the server not to use them and declines their permission requests, so your chat's tools do the work; Antigravity may still run built-in tools that never ask for permission. Machine-scoped. |
| `googleAcp.authPreference` | `auto` | `auto` uses the saved key when there is one, otherwise the account; `apiKey` uses the key; `oauth` ignores the key, `GEMINI_API_KEY` and `GOOGLE_API_KEY`. Restarts the agent. Machine-scoped. |
| `googleAcp.sessions.idleTimeoutSeconds` | `120` | A chat that has been idle this long gives back its agent session; its next message starts a new one rebuilt from the chat's transcript. `0` keeps the session until the chat limit or a restart closes it. Machine-scoped. |

## How it works

- The server is downloaded once from `https://dl.google.com/agy-extensions/releases`, pinned to a fixed version and to your platform's archive. Only HTTPS is accepted, and the download is checked against the size the server states (the ACP registry publishes no checksums). An earlier version is removed once the new one is in place.
- Each chat gets its own ACP session, rooted in the folder of the chat, and the reply is streamed back to Copilot. An idle chat gives its session back, and its next message starts a new session rebuilt from the chat's transcript. A session is also rebuilt when the chat's history, tool list or description no longer matches what it has seen.
- Copilot's tools reach the agent through a loopback MCP bridge on `127.0.0.1`, with one bearer token per session. Tool calls go through Copilot's confirmations, and requests with a foreign `Origin` or `Host` header are refused. A tool you disable stops being offered without starting the chat over.
- Only your request, its attachments, the editor selection and the state Copilot reports for that turn are forwarded, plus the context Copilot builds for the chat once, when a session starts. Copilot's skills, custom agents, instruction files and memory stay Copilot's own and reach the agent untouched. An open chat keeps the prompt it started with; new chats, or **Google ACP: Restart Agent**, pick up changes.
- A tool call ends the response so Copilot can run the tool, and the next request carrying its result continues the same turn. A call the agent makes while Copilot is still running another is held for that next response, and stopping the chat cancels the agent's turn.
- Antigravity's own tools are off by default, as far as the server allows: the extension asks it not to use them and declines their permission requests, so the tools of your chat do the work. `googleAcp.useAgentBuiltInTools` turns that around.
- There is no usage meter: the server reports the plan tier, not plan usage, so the status bar shows only a warning when a request is refused for using up the plan, with the time the limit lifts when the server gives one.
- After three failed starts in a row, the agent stays down for two minutes until **Google ACP: Restart Agent**.

## Troubleshooting

- **No models.** Run **Set Up**. If it still fails, check the **Google ACP** output channel, then restart the agent.
- **Sign-in required.** Run **Sign In**, then **Restart Agent**. A failed sign-in means the browser flow ended without a token; the output channel has the reason, or save a Gemini API key instead.
- **The program was not found.** `googleAcp.agent.command` names something that is not on the machine: install it, or point the setting at it. A `.cmd` launcher goes through `cmd.exe`, where quoting cannot be trusted, so an argument with spaces in it is refused; point the setting at the program or its script instead.
- **The download failed.** The output channel names the reason. Running **Set Up** again starts a fresh attempt; a failed one leaves nothing behind.
- **Usage limit reached.** The warning names the reset time when the server gives one. Nothing is retried behind your back; ask again once it has passed.

## Privacy

- No telemetry. Your prompts go only to the Google ACP server the extension starts on your machine, which talks to Google under your own account. On first use the extension downloads that server from `https://dl.google.com/agy-extensions/releases`; nothing else is fetched.
- A saved Gemini API key lives in secret storage and reaches only the local agent process, as `GEMINI_API_KEY`. It is never written to settings or logs.
- The local MCP bridge listens on `127.0.0.1` only and requires a per-session token. Logs never record your email address or account identifiers.

## License

MIT. See `LICENSE`.