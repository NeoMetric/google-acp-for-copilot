# Changelog

## 0.1.6 - 2026-10-29

### Added

- A chat continued after the window was reloaded resumes its stored agent conversation instead of pasting the chat into a new session, so the prompt cache serves it. Each step is logged under `[reuse]`, with the cache figures of the first model call afterwards.

### Changed

- Copilot's system prompt now reaches the agent with only Copilot's personality and identity removed. The behaviour it states ahead of its first section, such as following the user's requirements to the letter, is kept; the content policy is carried once, by the intro the extension writes; its `[copilot_cache_control]` markers are dropped; and a prompt that has no sections at all is no longer lost.
- The intro the extension writes now tells the agent that a note on a tool result is the user's newest message, as the other ACP extensions do, and words the `call_mcp_tool` rule the same way.
- A failed turn keeps its session instead of starting a new one, so the next message reads the conversation from the prompt cache rather than paying for the prompt again. A session that fails three times in a row, loses its connection or needs a sign-in is still replaced.
- When no chat has a session left, the agent process, with the helper processes the Antigravity server started, is stopped after 30 minutes and started again by the next message, so an unused window no longer keeps them running. The new `googleAcp.agent.idleShutdownMinutes` setting changes the time; `0` turns it off.

## 0.1.5 - 2026-10-24

### Fixed

- A message typed while a tool call is running now ends that turn and reaches the agent as a new prompt in the same session. Copilot delivers it beside the tool results, so it used to be folded into them and the agent never read it.
- The result of a tool call the agent already gave up on, such as one that timed out, no longer makes the next request look like a new conversation. The running turn still answers the request and the result is dropped.
- A turn that never finished, because a tool call was abandoned or the user stopped it, no longer makes the next request look like the start of the chat, so the first message is not sent to the agent a second time.

## 0.1.4 - 2026-10-24

### Added

- The agent is now told, for every tool the chat offers, which arguments that tool's schema requires. Antigravity reaches the chat's tools through a generic wrapper and otherwise skips arguments such as a terminal command's `description`, which leaves the command as the title of the call. The list is read from the schema Copilot publishes, so a renamed or added argument needs no code change.
- The reminders Copilot repeats beside each request now reach the agent. They carry the editing contract for the tools it calls through Copilot: `...existing code...` for `insert_edit_into_file`, the surrounding lines to quote for `replace_string_in_file`, and the preference for the multi-replace tool.
- The context Copilot builds for the whole chat now reaches the agent too, once, when a session starts: the operating system, the layout of the workspace, the user preferences and the memory the host had loaded. It was dropped before, so the agent had to rediscover the workspace with tools.
- Each request keeps the tools the user pointed at with `#tool`, the notebook formatting instructions, and the attachments — in the order Copilot writes them.
- The guidance Copilot writes into its system prompt now reaches the agent: the working directory, the repository rules, the tool directory and the user's preferences. Every system message contributes instead of only the first. Only the identity preamble is left out, since the agent has a prompt of its own.
- A chat session is rebuilt when Copilot starts offering a tool the session never saw, such as `task_complete` when autopilot is switched on, or when Copilot describes the chat differently, such as switching between asking and working. The conversation is restored into the new session. A session opened by a request that offered no tools, such as a chat title, gets the workspace prompt on the first request that offers them.
- A request that offers no tools no longer empties the chat's tool list or pays for a workspace prompt the agent could not act on, since it has no tool to read a file with.
- A request that carries no text fails with a clear error instead of sending an earlier message to the agent a second time.
- A tool the user disables now stops being offered to the agent, and one they enable starts being callable, without the chat starting over. The bridge announces `notifications/tools/list_changed` over an MCP notification stream and answers `initialize` with that capability.
- The output channel now names every request: the model, the message count, and the full list of tools sent with it. Closing a chat session is logged too.
- A system prompt the host re-renders between requests, such as one that spells a drive letter in another case, no longer looks like a rewritten history and no longer restarts the session.

### Removed

- The extension no longer lists skills of its own, and `SKILLS_CHAR_BUDGET` and the `## Skills` section are gone. Copilot renders the skill list into the system prompt of every harness it offers, and that prompt now reaches the agent, so listing them again only paid for them twice: the entry carried no file path on the agent host, so every skill was repeated. Copilot's list wins outright, so its own filtering is honoured too. `chat.useAgentSkills` and `chat.agentSkillsLocations` are now Copilot's to apply, and `src/skills.ts` is deleted with its tests.
- The extension no longer lists custom agents either, and no longer reads `*.agent.md` files or consults `chat.agentFilesLocations`. Both harnesses list the agents themselves — the chat panel in an `<agents>` block, the agent host in its `task` tool — with names and descriptions, and neither prints a file path, so every agent was repeated with only its path new.
- Instruction files are no longer read and inlined into the prompt: `loadInstructions`, the 20,000-character instruction budget and the `## Instructions from …` sections are gone. Copilot lists `copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md` and `*.instructions.md` in its own index with their paths, and the agent reads the one that applies, as Copilot intends. Every `*.instructions.md` is now a pointer, including one whose `applyTo` covers everything.
- The memory section the extension added is removed, together with the tool list it was gated on. Copilot's own rules for the `memory` tool are forwarded instead.

### Fixed

- A `*.instructions.md` or `*.prompt.md` file that Copilot already names in its own system prompt is no longer pointed out a second time. One it does not name is still listed, so the agent can read it when it applies.
- Copilot's memory rules are forwarded as they stand, and the memory section the extension wrote in their place is gone. The rules describe the same `/memories/` tool the chat offers, with its scopes and the note-keeping guidelines, so Copilot owns memory end to end. Its claim that user memory is loaded into the context is true here: those blocks are forwarded once per session with the rest of the chat context.
- The identity preamble keeps the host's rules for what the model may produce: `Follow Microsoft content policies`, the copyright line and the refusal for harmful content now reach the agent, carried in the intro the extension writes in place of the host's identity.

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
