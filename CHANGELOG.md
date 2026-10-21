# Changelog

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
