# Shell icons in command rows

## Goal

Reduce repeated shell executable paths in tool rows while retaining the command that actually ran.

## Implementation

`utils/shellCommand.ts` recognizes PowerShell, Bash, Command Prompt, Zsh, Fish, and sh wrappers. When a recognized shell is invoked with its command flag, the row shows the inner command instead of the executable path and flag. `ShellIcon` renders an app-specific icon with an accessible name; hovering it or the command exposes the full original invocation. Command output still retains the original copy text. Unknown command shapes keep their original text and the Bash tool icon.

## Verification

- Browser mock showed PowerShell, Bash, and Command Prompt icons with only their inner commands, plus a direct command with the Bash icon.
- Visual inspection of a PowerShell row showed the icon, readable command, and existing output link without the repeated executable path.
- `yarn.cmd build` passed. The separate webview type check still reports the pre-existing `SyntaxHighlighter` JSX type error in `FileViewerModal.tsx`.
