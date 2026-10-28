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

1. Run **Google ACP: Set Up**, or accept the prompt after installing. It downloads the server (about 125 MB) and starts it.
2. Run **Google ACP: Sign In (Google Account or API Key)** if you are not signed in yet: the server opens Google's sign-in page in your browser, or you save a Gemini API key.
3. In Copilot Chat, pick a model under **Google Agent**.

The server takes a while to start: about 10 to 30 seconds, depending on the machine.

Logs go to the **Google ACP** output channel. At the default Info level every request is named with its model, the message count and the tools sent with it, and a chat session is logged when it opens and when it closes. Set the level to Debug to also see tool titles and permission requests.

## Signing in

| Method | Billing |
| --- | --- |
| Google account (browser sign-in run by the ACP server) | Your Antigravity plan, with the limits Google sets |
| Gemini API key (saved in the OS keychain, handed to the server as `GEMINI_API_KEY`) | Per token, against the key's project |

- `googleAcp.authPreference` decides what is used when both exist. The default, `auto`, lets a saved key beat a signed-in account; `apiKey` uses the key; `oauth` keeps the account and withholds the saved key, `GEMINI_API_KEY` and `GOOGLE_API_KEY` from the agent.
- Saving or removing a key restarts the agent so it picks the change up. Choosing a browser sign-in while a key is saved asks whether to remove the key first.
- Sign-in happens inside the server: the browser flow is Google's and the tokens it stores never reach the extension.
- A saved key beats a signed-in account, and beats a `GEMINI_API_KEY` or `GOOGLE_API_KEY` set in the environment VS Code starts from. `oauth` withholds all of them and keeps the account.

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

- The server is downloaded once from `https://dl.google.com/agy-extensions/releases`, pinned to a fixed version and to the archive of your platform, each in a folder of its own. Only HTTPS is accepted, a few redirects are followed, and the download is checked against the size the server states; the ACP registry publishes no checksums, so there is nothing stronger than that. An earlier version is removed once the new one is in place.
- Each chat gets its own ACP session, rooted in the folder of the chat, and the reply is streamed back to Copilot. An idle chat gives its session back, and its next message starts a new session rebuilt from the chat's transcript.
- Copilot's tools reach the agent through a loopback MCP bridge on `127.0.0.1`, with one bearer token per session. Tool calls go through Copilot's confirmations, and requests with a foreign `Origin` or `Host` header are refused. The bridge tells the agent when the chat's tool list changes, so a tool you disable stops being offered and one you enable starts being callable without starting the chat over.
- Only your request, its attachments, the editor selection and the state Copilot reports for that turn are forwarded. The reminders Copilot repeats beside a request carry the editing contract for the tools it calls through Copilot, so they go along with it. The context Copilot builds for the whole chat — the operating system, the layout of the workspace and the memory it loaded — is forwarded once, when a session starts, and the guidance Copilot writes in its system prompt is appended to the agent's own prompt.
- A tool call ends the response so Copilot can run the tool, and the next request carrying its result continues the same turn. A call the agent makes while Copilot is still running another is held for that next response rather than failed, and stopping the chat cancels the agent's turn even after a tool call was handed over.
- A chat session is rebuilt when the chat's history no longer matches what it has seen, when Copilot starts offering a tool the session never saw, or when Copilot describes the chat differently, for example when autopilot is switched on. The conversation is restored into the new session from the messages Copilot still has.
- Skills, custom agents, instruction files and memory stay Copilot's own. The system prompt Copilot renders for the chat reaches the agent untouched, including its skill list, its agent list, the file paths of the instruction files and its rules for the `memory` tool. The extension reads none of them, inlines no instruction text and writes no memory rules of its own. Only what Copilot does not list is pointed out: a `*.instructions.md` or `*.prompt.md` file, from `~/.copilot`, the workspace or the folders named by `chat.instructionsFilesLocations` and `chat.promptFilesLocations`, when Copilot's own index does not already name it. An open chat keeps the prompt it started with; new chats, or **Google ACP: Restart Agent**, pick up changes.
- Antigravity's own tools are off by default, as far as the server allows: the extension asks it not to use them and declines their permission requests, so the tools of your Copilot chat do the work. `googleAcp.useAgentBuiltInTools` turns that around, and then the agent's own file, shell and search tools act on the workspace directly.
- There is no usage meter. The server reports the plan tier, not plan usage, over ACP, so the extension cannot show how much of your plan is left. What it does show is a warning in the status bar when a request is refused for using up the plan, with the time the limit lifts when the server says it; the item goes away when a request succeeds or that time has passed.

## Troubleshooting

- **No models.** Run **Google ACP: Set Up**. If that does not help, check the **Google ACP** output channel, then run **Google ACP: Restart Agent**.
- **Sign-in required.** A warning says so with a **Sign In** button. Run **Google ACP: Sign In**, then **Google ACP: Restart Agent**.
- **Sign-in failed.** `Google ACP: sign-in did not complete.` means the browser flow ended without a token; the output channel has the reason the server reported. Try again, or save a Gemini API key instead.
- **The program was not found.** When `googleAcp.agent.command` names something that is not on the machine, a notification says so: install it, or point the setting at it. A `.cmd` launcher goes through `cmd.exe`, where quoting cannot be trusted, so an argument with spaces in it is refused; point the setting at the program or its script instead.
- **The download failed.** The output channel names the reason: a non-HTTPS address, too many redirects, an HTTP status, a download that stopped early, or a machine without `unzip` on Linux. Running **Google ACP: Set Up** again starts a fresh attempt; a failed one leaves nothing behind.
- **The agent keeps stopping.** Three starts that die within ten seconds make the extension refuse further starts for two minutes, with a message naming **Google ACP: Restart Agent**. Check the output channel for the reason the process exited.
- **Usage limit reached.** The status bar warning names the reset time when the server gives one. Nothing is retried behind your back; ask again once it has passed.

## Privacy

- No telemetry. Your prompts go only to the Google ACP server the extension starts on your machine, which talks to Google under your own account.
- On first use the extension downloads that server from `https://dl.google.com/agy-extensions/releases`; nothing else is fetched.
- A saved Gemini API key lives in secret storage and reaches only the local agent process, as `GEMINI_API_KEY`. It is never written to settings or logs.
- The local MCP bridge listens on `127.0.0.1` only and requires a per-session token.
- Logs never record your email address or account identifiers.

## License

MIT. See `LICENSE`.