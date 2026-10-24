# Changelog

## Unreleased

- The reminders Copilot repeats beside each request now reach the agent. They carry the editing contract for the tools it calls through Copilot: `...existing code...` for `insert_edit_into_file`, the surrounding lines to quote for `replace_string_in_file`, and the preference for the multi-replace tool.
- The context Copilot builds for the whole chat now reaches the agent too, once, when a session starts: the operating system, the layout of the workspace, the user preferences and the memory the host had loaded. It was dropped before, so the agent had to rediscover the workspace with tools.
- Each request keeps the tools the user pointed at with `#tool`, the notebook formatting instructions, and the attachments — in the order Copilot writes them.
- The guidance Copilot writes into its system prompt now reaches the agent: the working directory, the repository rules, the tool directory and the user's preferences. It is appended ahead of the skills and instruction files, and every system message contributes instead of only the first. The identity preamble and Copilot's own memory rules are dropped, since the agent has a prompt and a memory section of its own.
- Skills, instruction files and custom-file pointers that Copilot already writes into its own system prompt are no longer added a second time. A workspace with `copilot-instructions.md` and a large skill folder was paying for every one of them twice.
- The memory section names the file reader the chat actually offers — `read_file` through the MCP bridge when Copilot offers it, `view` otherwise — instead of always `view`.
- A chat session is rebuilt when Copilot starts offering a tool the session never saw, such as `task_complete` when autopilot is switched on, or when Copilot describes the chat differently, such as switching between asking and working. The conversation is restored into the new session. A session opened by a request that offered no tools, such as a chat title, gets the workspace prompt on the first request that offers them.
- A request that offers no tools no longer empties the chat's tool list or pays for a workspace prompt the agent could not act on, since it has no tool to read a file with.
- A request that carries no text fails with a clear error instead of sending an earlier message to the agent a second time.
- A tool the user disables now stops being offered to the agent, and one they enable starts being callable, without the chat starting over. The bridge announces `notifications/tools/list_changed` over an MCP notification stream and answers `initialize` with that capability.
- The output channel now names every request: the model, the message count, and the full list of tools sent with it. Closing a chat session is logged too.
- A system prompt the host re-renders between requests, such as one that spells a drive letter in another case, no longer looks like a rewritten history and no longer restarts the session.

## 0.1.3 - 2026-10-24

- Discovers Copilot skills (`SKILL.md`), workspace instructions (`.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `.instructions.md`), custom agents (`.agent.md`), and prompt files (`.prompt.md`) from `.copilot/`, `.claude/`, `.agents/`, and `.github/` directories as well as configured skill/prompt locations, and includes them in the agent's system prompt.
- Strips redundant Copilot environment and memory wrappers from incoming chat requests so the agent receives clean user prompts, attachments, and editor context.
- Limits transcript block history to 40,000 characters and omits preamble messages before the first user prompt.
- Tracks session token usage and prompt cache statistics on turn completion in the provider.

## 0.1.2 - 2026-10-23

- The instruction appended to the agent's system prompt now also asks it to read a tool's schema file before first use and to pass every argument the schema lists as required. The agent reaches the chat's tools through a generic MCP wrapper and otherwise skips arguments such as a terminal command's `description`.
- At debug level, the bridge logs the arguments of each `tools/call` and the agent's raw `tool_call` and `tool_call_update` messages, to diagnose what the agent sends for a tool.

## 0.1.1 - 2026-10-23

- A tool call the agent makes while Copilot is still running another no longer fails with "no chat request is waiting for it": it is held and sent with the next response.
- Stopping a chat now cancels the agent's turn even after a tool call was handed to Copilot, and a tool call Copilot never picks up is failed before the agent's own three-minute MCP timeout instead of stalling the step.
- Tool calls are handed to Copilot as soon as the agent stops issuing them (40 ms of quiet, up to 250 ms) instead of always waiting the full 250 ms, which took that wait off every tool call.
- The agent's harness output is logged at the level the harness itself reports, so forwarded `I`/`W` lines no longer show up as errors.

## 0.1.0

- First release, derived from Claude ACP for Copilot.
- Runs Google's official Antigravity ACP server (`agy_acp_server`, ACP registry id `antigravity-acp`, version 1.4.1).
- Asks the server not to use its own tools and declines their permission requests, so Copilot's tools do the work (`googleAcp.useAgentBuiltInTools` turns this off).
- **Set Up** downloads the Antigravity server once into extension storage (HTTPS only, size checked, one folder per version).
- Signs in through the server's own `authenticate` (Google account in the browser, or a Gemini API key kept in VS Code's secret storage).
- Publishes the server's models to the Copilot model picker, with the model chosen through the ACP model config option.
- Appends an instruction to the agent's system prompt to use only the chat's tools (the server advertises `systemPrompt.append`).
- When a request hits a usage limit, shows a clear message and a status bar item with the reset time when the server's error carries one. The server reports no remaining quota over ACP, so there is no meter.
- Shows the plan tier in **Show Agent and Credentials** when the server reports one, and logs the server's `_meta` at debug level to find what else it offers.
