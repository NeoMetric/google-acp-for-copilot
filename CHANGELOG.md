# Changelog

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
