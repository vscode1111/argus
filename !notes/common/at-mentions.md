# How `@` file mentions reach the CLI

What the Claude CLI does with an `@path` in the mode Argus spawns it
(`--print --verbose --output-format stream-json --input-format stream-json`, text delivered
as NDJSON on stdin - see `handleSend` in `src/backend/session.ts`). Everything here was
measured against a real CLI, not read from docs.

Applies to anything that composes the text sent to the CLI, or that renders a mention back
to the user: `webview/src/components/InputArea.tsx` (the picker and its highlight overlay),
`webview/src/utils/filePath.tsx` (`findMentions`), `src/backend/fileSearch.ts`.

## The CLI does expand `@`, and a space silently breaks it

| Mention | Expanded |
|---|---|
| `@notes.md` | **yes** - contents injected, zero tools used |
| `@My Folder/some file.md` | no |
| `@Бискуб Тест/Военный билет 12.md` | no - *"the `@` file reference did not attach any content to this message"* |

Its parser stops at the first space, exactly as a naive `@\S+` would. The failure is
**silent**: no error, no warning, the mention just becomes prose, and the model then goes
hunting for a file it was supposedly handed (Glob/Grep/Read), which reads like the model
being slow rather than like a broken attachment.

## `@"path with spaces"` is the form that works

| Form | Result |
|---|---|
| `@"My Folder/some file.md"` | **PASS** |
| `@"C:\...\My Folder\some file.md"` (absolute) | **PASS** |
| `@'My Folder/some file.md'` | fail |
| `@My\ Folder/some\ file.md` | fail - *"Prompt is too long"* |
| `"@My Folder/some file.md"` (quote outside the `@`) | fail |
| `@C:\...\My Folder\some file.md` (bare absolute) | fail - *"Prompt is too long"* |

Double quotes only, and they go **after** the `@`. Being delimited, the quoted form is also
unambiguous to *match*, which is why Argus needs no filesystem lookup to decide where a
mention ends - `MENTION_RE` is `/(?<=^|\s)@(?:"[^"\n]*"|\S+)/g`. Quote only when the path
contains a space (`mentionFor()` in `fileSearch.ts`); quoting unconditionally puts quotes
around the common case for nothing.

## An `@folder` inlines the CONTENTS of everything under it

Not a listing. With **every** file-reading tool disallowed, the model still quoted tokens
from inside two files in a mentioned folder:

| Mention | Filenames | File contents |
|---|---|---|
| `@"Папка Тест/"` | yes | **yes** |
| `@"Папка Тест"` (no trailing slash) | yes | **yes** |
| no mention (baseline) | no | no |

So offering folders in a picker is a real and potentially expensive action, not decoration -
a documents folder of `.jpg` and `.docx` gets pulled in wholesale. Argus surfaces each
folder's immediate entry count on its picker row for that reason.

Input tokens went 38,375 (baseline) -> 56,339 (folder mention). That delta is **measured,
not explained**: two tiny text files cannot account for ~18k, so something else loads when a
mention is present. Do not quote it as the cost of inlining.

This also makes the two *"Prompt is too long"* failures above plausible - a mangled prefix
like `@C:\...\My` being taken for a folder would inline it - but the mechanism is only shown
to **exist**; that those runs hit it is still inference.

## How to probe this

The discriminator that makes these results trustworthy: put a **unique per-run random
token** inside the file and disallow every route to the bytes
(`--disallowedTools Read,Glob,Grep,Bash,PowerShell,ToolSearch,Edit,Write,NotebookEdit,Task,WebFetch,WebSearch`).
A correct answer can then only come from the CLI having expanded the mention itself.

Two traps, both hit on the first attempt:

- **A no-space control is mandatory.** The first run omitted it and concluded "the CLI never
  expands `@` in this mode" - wrong, and it would have sent the design the opposite way.
  Without a case that *should* work, "no expansion at all" and "expansion broken by a space"
  are indistinguishable.
- **Score on an exact token match, never on confidence.** One run answered with a
  hallucinated `test-token-12345` (and an unprompted English-correction section - the
  user-level `~/.claude/CLAUDE.md` loads even in a tmpdir workspace). "Did it answer
  confidently" would have scored that PASS.

Scripts: [../tasks/path-with-spaces-mention/scripts/probe-cli-at-expansion.js](../tasks/path-with-spaces-mention/scripts/probe-cli-at-expansion.js),
[probe-at-quoting.js](../tasks/path-with-spaces-mention/scripts/probe-at-quoting.js),
[probe-at-folder.js](../tasks/path-with-spaces-mention/scripts/probe-at-folder.js).

## Where a mention cannot be resolved lexically

Deciding where an **unquoted** space-bearing mention ends is not solvable with a regex, and
three candidate rules were built and killed proving it
([probe-mention-re.js](../tasks/path-with-spaces-mention/scripts/probe-mention-re.js)). The
decisive counter-example:

```
ping @snowy about the build see src/file.md
```

Any rule that crosses spaces hunting for an extension swallows the sentence; anchoring on an
extension instead regresses the plain-handle case. This is why the picker resolves against
the host (`searchFiles`) and inserts the quoted form, rather than guessing. Do not retry a
regex here.
