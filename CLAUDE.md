# Argus - VS Code Extension

AI coding assistant powered by Claude, built as a VS Code extension.

## Project Structure

```
src/
  extension.ts          - Activation entry point, registers commands/providers
  agent/
    ClaudeClient.ts     - Anthropic SDK wrapper, streaming + tool use
    AgentLoop.ts        - Agentic loop orchestrating tools and conversation
    tools/              - Individual tool implementations (read, write, edit, glob, grep, bash)
  chat/
    ChatPanel.ts        - WebviewPanel lifecycle and message handling
    ChatMessage.ts      - Message types
  providers/
    InlineSuggestProvider.ts  - Inline completions (Copilot-style)
    CodeLensProvider.ts       - "Ask Argus" code lens
  utils/
    config.ts           - Extension settings helpers
    workspace.ts        - VS Code workspace helpers
media/
  chat.html/css/js      - Webview UI
```

## Key Conventions

- Model: `claude-opus-4-6` for agent (adaptive thinking), `claude-haiku-4-5` for inline completions
- Streaming: always use `client.messages.stream()` + `finalMessage()`
- Tool approval: destructive tools (write_file, bash) require user confirmation via `showWarningMessage`
- No Python scripts - use Node.js/TypeScript for any tooling

## Development

```sh
npm run compile     # compile TypeScript
npm run watch       # watch mode
# Press F5 in VS Code to launch Extension Development Host
```

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| argus.openChat | Ctrl+Shift+A | Open chat panel |
| argus.askSelection | Ctrl+Shift+Q | Ask about selected code |
| argus.editSelection | - | Edit selected code with AI |
| argus.reviewSelection | - | Code review of selection |
| argus.newSession | - | Start fresh conversation |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| argus.apiKey | "" | Anthropic API key |
| argus.model | claude-opus-4-6 | Model to use |
| argus.inlineCompletions.enabled | false | Enable inline completions |
| argus.codeLens.enabled | true | Show code lens |
| argus.bash.useIntegratedTerminal | true | Run bash in terminal |
