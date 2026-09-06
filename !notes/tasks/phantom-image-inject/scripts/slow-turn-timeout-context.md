# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: send-while-streaming-integration.spec.ts >> send while streaming >> second message sent during streaming appears as inline inject
- Location: e2e\send-while-streaming-integration.spec.ts:16:7

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('button', { name: 'Stop' })
Expected: 0
Received: 1

Call log:
  - Expect "toHaveCount" with timeout 90000ms
  - waiting for getByRole('button', { name: 'Stop' })
    30 × locator resolved to 1 element
       - unexpected value "1"

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - generic [ref=e5]:
    - generic [ref=e6]:
      - button "New chat" [ref=e7] [cursor=pointer]:
        - img [ref=e8]
      - button "Refresh current session" [disabled] [ref=e10] [cursor=pointer]:
        - img [ref=e11]
      - button "Session history" [ref=e15] [cursor=pointer]:
        - img [ref=e16]
      - button "Switch workspace" [ref=e17] [cursor=pointer]:
        - generic [ref=e18]: argus
      - 'button "Usage limits. Session (5hr): 5% · Resets in 4h 27m · Sun 3:59 PM. Weekly (7 day): 19% · Resets in 9h 27m · Sun 8:59 PM. Weekly Fable: 0%" [ref=e19] [cursor=pointer]'
      - button "Hide session bar" [ref=e25] [cursor=pointer]:
        - img [ref=e26]
    - generic [ref=e30]:
      - generic [ref=e31]:
        - generic [ref=e32]: Read package.json, then read CLAUDE.md, then summarize both.
        - button "Copy to clipboard" [ref=e33] [cursor=pointer]: ⧉
      - generic [ref=e34]:
        - generic [ref=e35] [cursor=pointer]:
          - generic [ref=e36]:
            - generic [ref=e37]: Thinking...
            - generic [ref=e38]: 6 tok
            - generic [ref=e39]: ›
          - generic [ref=e40]: Let me read both files.
        - generic [ref=e41]:
          - text: What is 123 + 456? Reply with just the number.
          - button "Copy to clipboard" [ref=e42] [cursor=pointer]: ⧉
        - paragraph [ref=e44]: Reading both files now.
        - generic [ref=e46]:
          - generic [ref=e47]: Read
          - link "D:\\_Projects\\scub111g\\argus\\package.json" [ref=e48] [cursor=pointer]:
            - /url: "#"
        - generic [ref=e50]:
          - generic [ref=e51]: Read
          - link "D:\\_Projects\\scub111g\\argus\\CLAUDE.md:1-50" [ref=e52] [cursor=pointer]:
            - /url: "#"
        - generic [ref=e53]:
          - paragraph [ref=e54]:
            - strong [ref=e55]: "package.json summary:"
          - list [ref=e56]:
            - listitem [ref=e57]:
              - text: "Name:"
              - code [ref=e58]: argus
              - text: ", version"
              - code [ref=e59]: 0.0.93
              - text: ", a VS Code extension (\"AI coding assistant powered by Claude\")"
            - listitem [ref=e60]:
              - text: "Key scripts:"
              - code [ref=e61]: yarn dev
              - text: (Vite + WS server),
              - code [ref=e62]: yarn build
              - text: (webview bundle),
              - code [ref=e63]: yarn daemon
              - text: (always-on daemon on port 3017),
              - code [ref=e64]: yarn test:e2e
              - text: (Playwright)
            - listitem [ref=e65]:
              - text: "Runtime deps:"
              - code [ref=e66]: ws
              - text: (WebSocket),
              - code [ref=e67]: koffi
              - text: (Win32 FFI),
              - code [ref=e68]: remark-gfm/breaks
              - text: (markdown)
            - listitem [ref=e69]: "Dev deps: React 18, TypeScript, Vite, Playwright, react-markdown, react-syntax-highlighter"
            - listitem [ref=e70]:
              - text: "Contributes: commands ("
              - code [ref=e71]: argus.openChat
              - text: Ctrl+Shift+A,
              - code [ref=e72]: argus.askSelection
              - text: Ctrl+Shift+Q, etc.), context menus, VS Code settings (model, inline completions, code lens)
          - paragraph [ref=e73]:
            - strong [ref=e74]: "CLAUDE.md summary:"
          - list [ref=e75]:
            - listitem [ref=e76]: "Architecture: VS Code extension with a React/Vite webview frontend and a Node.js WebSocket backend; optionally runs as a standalone always-on daemon (port 3017)"
            - listitem [ref=e77]:
              - text: Backend (
              - code [ref=e78]: src/backend/
              - text: "): session/channel management for multi-client shared sessions, CLI spawning/watchdog/retry"
        - generic [ref=e79]: 27s · 98,920 in / 396 out
    - generic [ref=e80]:
      - generic [ref=e82]:
        - textbox "Ask Argus... (paste images, text, or PDFs with Ctrl+V)" [ref=e84]
        - generic "Connected" [ref=e85]
      - generic [ref=e86]:
        - generic [ref=e87]:
          - button "Edit" [ref=e88] [cursor=pointer]
          - 'generic "38% used Input: 76,416 tokens Output: 1 tokens Window: 200,000 tokens" [ref=e89]': 38%
          - button "Settings" [ref=e91] [cursor=pointer]: ⚙
        - generic [ref=e92]:
          - button "Send" [active] [ref=e93] [cursor=pointer]:
            - img [ref=e94]
          - button "Stop" [ref=e96] [cursor=pointer]:
            - img [ref=e97]
  - generic [ref=e101]:
    - generic [ref=e102]:
      - generic [ref=e103]: Debug Log (55)
      - generic [ref=e104]:
        - button "⚙" [ref=e106] [cursor=pointer]
        - button "Clear" [ref=e107] [cursor=pointer]
        - button "✕" [ref=e108] [cursor=pointer]
    - generic [ref=e110]:
      - generic [ref=e111]:
        - generic [ref=e112]:
          - generic [ref=e113]: 11:31:37.446
          - generic [ref=e114]: INFO
        - generic [ref=e115]: "Spawning claude: --print --verbose --output-format stream-json --input-format stream-json --include-partial-messages --tools Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch,AskUserQuestion --allowedTools Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch,AskUserQuestion --effort low"
      - generic [ref=e116]:
        - generic [ref=e117]:
          - generic [ref=e118]: 11:31:37.457
          - generic [ref=e119]: DEBUG
        - generic [ref=e120]: "stdin: 139 bytes"
      - generic [ref=e121]:
        - generic [ref=e122]:
          - generic [ref=e123]: 11:31:37.752
          - generic [ref=e124]: INFO
        - generic [ref=e125]: "Mid-turn inject: 125 bytes to stdin"
      - generic [ref=e126]:
        - generic [ref=e127]:
          - generic [ref=e128]: 11:31:38.835
          - generic [ref=e129]: DEBUG
        - generic [ref=e130]: "event: system {\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"D:\\\\_Projects\\\\scub111g\\\\argus\",\"session_id\":\"cefd2b90-7a04-497e-8a17-d55d7639b"
      - generic [ref=e131]:
        - generic [ref=e132]:
          - generic [ref=e133]: 11:31:38.836
          - generic [ref=e134]: DEBUG
        - generic [ref=e135]: "event: system {\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\",\"uuid\":\"f859963b-e5cd-4938-bce2-33d500b9af2f\",\"session_id\":\"ce"
      - generic [ref=e136]:
        - generic [ref=e137]:
          - generic [ref=e138]: 11:31:51.482
          - generic [ref=e139]: DEBUG
        - generic [ref=e140]: "event: rate_limit_event {\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\",\"resetsAt\":1788699600,\"rateLimitType\":\"five_hour\",\"over"
      - generic [ref=e141]:
        - generic [ref=e142]:
          - generic [ref=e143]: 11:31:53.444
          - generic [ref=e144]: DEBUG
        - generic [ref=e145]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"id\":\"msg_011Cemsh75dCqKKY"
      - generic [ref=e146]:
        - generic [ref=e147]:
          - generic [ref=e148]: 11:31:53.444
          - generic [ref=e149]: DEBUG
        - generic [ref=e150]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\","
      - generic [ref=e151]:
        - generic [ref=e152]:
          - generic [ref=e153]: 11:31:53.486
          - generic [ref=e154]: DEBUG
        - generic [ref=e155]: "event: system {\"type\":\"system\",\"subtype\":\"thinking_tokens\",\"estimated_tokens\":6,\"estimated_tokens_delta\":6,\"uuid\":\"c8c11905-2bf0-47fd-"
      - generic [ref=e156]:
        - generic [ref=e157]:
          - generic [ref=e158]: 11:31:53.487
          - generic [ref=e159]: DEBUG
        - generic [ref=e160]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Let"
      - generic [ref=e161]:
        - generic [ref=e162]:
          - generic [ref=e163]: 11:31:53.487
          - generic [ref=e164]: DEBUG
        - generic [ref=e165]: "event: system {\"type\":\"system\",\"subtype\":\"thinking_tokens\",\"estimated_tokens\":75,\"estimated_tokens_delta\":69,\"uuid\":\"1cabb63a-b25e-4de"
      - generic [ref=e166]:
        - generic [ref=e167]:
          - generic [ref=e168]: 11:31:53.487
          - generic [ref=e169]: DEBUG
        - generic [ref=e170]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"Eq"
      - generic [ref=e171]:
        - generic [ref=e172]:
          - generic [ref=e173]: 11:31:53.503
          - generic [ref=e174]: DEBUG
        - generic [ref=e175]: "event: assistant {\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"id\":\"msg_011Cemsh75dCqKKYXR7wbyhV\",\"type\":\"message\",\"role\":\""
      - generic [ref=e176]:
        - generic [ref=e177]:
          - generic [ref=e178]: 11:31:53.504
          - generic [ref=e179]: DEBUG
        - generic [ref=e180]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":0},\"session_id\":\"cefd2b90-7a04-497e-8a17-d55d7639b5c"
      - generic [ref=e181]:
        - generic [ref=e182]:
          - generic [ref=e183]: 11:31:53.504
          - generic [ref=e184]: DEBUG
        - generic [ref=e185]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}},\"sessi"
      - generic [ref=e186]:
        - generic [ref=e187]:
          - generic [ref=e188]: 11:31:53.504
          - generic [ref=e189]: DEBUG
        - generic [ref=e190]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Reading both"
      - generic [ref=e191]:
        - generic [ref=e192]:
          - generic [ref=e193]: 11:31:53.517
          - generic [ref=e194]: DEBUG
        - generic [ref=e195]: "event: assistant {\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"id\":\"msg_011Cemsh75dCqKKYXR7wbyhV\",\"type\":\"message\",\"role\":\""
      - generic [ref=e196]:
        - generic [ref=e197]:
          - generic [ref=e198]: 11:31:53.517
          - generic [ref=e199]: DEBUG
        - generic [ref=e200]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":1},\"session_id\":\"cefd2b90-7a04-497e-8a17-d55d7639b5c"
      - generic [ref=e201]:
        - generic [ref=e202]:
          - generic [ref=e203]: 11:31:53.517
          - generic [ref=e204]: DEBUG
        - generic [ref=e205]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01"
      - generic [ref=e206]:
        - generic [ref=e207]:
          - generic [ref=e208]: 11:31:53.517
          - generic [ref=e209]: DEBUG
        - generic [ref=e210]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e211]:
        - generic [ref=e212]:
          - generic [ref=e213]: 11:31:53.518
          - generic [ref=e214]: DEBUG
        - generic [ref=e215]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e216]:
        - generic [ref=e217]:
          - generic [ref=e218]: 11:31:54.050
          - generic [ref=e219]: DEBUG
        - generic [ref=e220]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e221]:
        - generic [ref=e222]:
          - generic [ref=e223]: 11:31:54.056
          - generic [ref=e224]: DEBUG
        - generic [ref=e225]: "event: assistant {\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"id\":\"msg_011Cemsh75dCqKKYXR7wbyhV\",\"type\":\"message\",\"role\":\""
      - generic [ref=e226]:
        - generic [ref=e227]:
          - generic [ref=e228]: 11:31:54.056
          - generic [ref=e229]: INFO
        - generic [ref=e230]: "tool_start: Read (toolu_01HJsT44hUsSPyVSAZ4YFsvg)"
      - generic [ref=e231]:
        - generic [ref=e232]:
          - generic [ref=e233]: 11:31:54.065
          - generic [ref=e234]: DEBUG
        - generic [ref=e235]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":2},\"session_id\":\"cefd2b90-7a04-497e-8a17-d55d7639b5c"
      - generic [ref=e236]:
        - generic [ref=e237]:
          - generic [ref=e238]: 11:31:54.066
          - generic [ref=e239]: DEBUG
        - generic [ref=e240]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01"
      - generic [ref=e241]:
        - generic [ref=e242]:
          - generic [ref=e243]: 11:31:54.066
          - generic [ref=e244]: DEBUG
        - generic [ref=e245]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e246]:
        - generic [ref=e247]:
          - generic [ref=e248]: 11:31:54.066
          - generic [ref=e249]: DEBUG
        - generic [ref=e250]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e251]:
        - generic [ref=e252]:
          - generic [ref=e253]: 11:31:54.067
          - generic [ref=e254]: DEBUG
        - generic [ref=e255]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e256]:
        - generic [ref=e257]:
          - generic [ref=e258]: 11:31:54.067
          - generic [ref=e259]: DEBUG
        - generic [ref=e260]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\""
      - generic [ref=e261]:
        - generic [ref=e262]:
          - generic [ref=e263]: 11:31:54.072
          - generic [ref=e264]: DEBUG
        - generic [ref=e265]: "event: assistant {\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"id\":\"msg_011Cemsh75dCqKKYXR7wbyhV\",\"type\":\"message\",\"role\":\""
      - generic [ref=e266]:
        - generic [ref=e267]:
          - generic [ref=e268]: 11:31:54.072
          - generic [ref=e269]: INFO
        - generic [ref=e270]: "tool_start: Read (toolu_01JMuC4PDu5EcXU2xicwo5no)"
      - generic [ref=e271]:
        - generic [ref=e272]:
          - generic [ref=e273]: 11:31:54.076
          - generic [ref=e274]: DEBUG
        - generic [ref=e275]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\",\"index\":3},\"session_id\":\"cefd2b90-7a04-497e-8a17-d55d7639b5c"
      - generic [ref=e276]:
        - generic [ref=e277]:
          - generic [ref=e278]: 11:31:54.084
          - generic [ref=e279]: DEBUG
        - generic [ref=e280]: "event: user {\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01HJsT44hUsSPyVSAZ4YFsvg\",\"type\":\"tool_result\","
      - generic [ref=e281]:
        - generic [ref=e282]:
          - generic [ref=e283]: 11:31:54.085
          - generic [ref=e284]: DEBUG
        - generic [ref=e285]: "user message: 1 block"
      - generic [ref=e286]:
        - generic [ref=e287]:
          - generic [ref=e288]: 11:31:54.085
          - generic [ref=e289]: DEBUG
        - generic [ref=e290]: "tool_result toolu_01HJsT44hUsSPyVSAZ4YFsvg: 1 { 2 \"name\": \"argus\", 3 \"version\": \"0.0.93\", 4 \"displayName\": \"Argus\", 5 \"description\": \"AI"
      - generic [ref=e291]:
        - generic [ref=e292]:
          - generic [ref=e293]: 11:31:54.117
          - generic [ref=e294]: DEBUG
        - generic [ref=e295]: "event: user {\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_01JMuC4PDu5EcXU2xicwo5no\",\"type\":\"tool_result\","
      - generic [ref=e296]:
        - generic [ref=e297]:
          - generic [ref=e298]: 11:31:54.117
          - generic [ref=e299]: DEBUG
        - generic [ref=e300]: "user message: 1 block"
      - generic [ref=e301]:
        - generic [ref=e302]:
          - generic [ref=e303]: 11:31:54.117
          - generic [ref=e304]: DEBUG
        - generic [ref=e305]: "tool_result toolu_01JMuC4PDu5EcXU2xicwo5no: 1 # Argus - VS Code Extension 2 3 AI coding assistant powered by Claude, built as a VS Code extensi"
      - generic [ref=e306]:
        - generic [ref=e307]:
          - generic [ref=e308]: 11:31:54.122
          - generic [ref=e309]: DEBUG
        - generic [ref=e310]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_deta"
      - generic [ref=e311]:
        - generic [ref=e312]:
          - generic [ref=e313]: 11:31:54.122
          - generic [ref=e314]: DEBUG
        - generic [ref=e315]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"message_stop\"},\"session_id\":\"cefd2b90-7a04-497e-8a17-d55d7639b5c5\",\"parent_tool_"
      - generic [ref=e316]:
        - generic [ref=e317]:
          - generic [ref=e318]: 11:31:54.139
          - generic [ref=e319]: DEBUG
        - generic [ref=e320]: "event: system {\"type\":\"system\",\"subtype\":\"status\",\"status\":\"requesting\",\"uuid\":\"54890bc3-08ce-45bc-8939-d91a87c0d21b\",\"session_id\":\"ce"
      - generic [ref=e321]:
        - generic [ref=e322]:
          - generic [ref=e323]: 11:31:58.957
          - generic [ref=e324]: DEBUG
        - generic [ref=e325]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"id\":\"msg_011CemshY5nCcsEr"
      - generic [ref=e326]:
        - generic [ref=e327]:
          - generic [ref=e328]: 11:31:58.957
          - generic [ref=e329]: DEBUG
        - generic [ref=e330]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}},\"sessi"
      - generic [ref=e331]:
        - generic [ref=e332]:
          - generic [ref=e333]: 11:31:58.957
          - generic [ref=e334]: DEBUG
        - generic [ref=e335]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"**\"}},\"sessi"
      - generic [ref=e336]:
        - generic [ref=e337]:
          - generic [ref=e338]: 11:31:59.549
          - generic [ref=e339]: DEBUG
        - generic [ref=e340]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"package.json"
      - generic [ref=e341]:
        - generic [ref=e342]:
          - generic [ref=e343]: 11:32:00.155
          - generic [ref=e344]: DEBUG
        - generic [ref=e345]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" coding assi"
      - generic [ref=e346]:
        - generic [ref=e347]:
          - generic [ref=e348]: 11:32:00.703
          - generic [ref=e349]: DEBUG
        - generic [ref=e350]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"webview bund"
      - generic [ref=e351]:
        - generic [ref=e352]:
          - generic [ref=e353]: 11:32:01.309
          - generic [ref=e354]: DEBUG
        - generic [ref=e355]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" deps: `ws`"
      - generic [ref=e356]:
        - generic [ref=e357]:
          - generic [ref=e358]: 11:32:01.840
          - generic [ref=e359]: DEBUG
        - generic [ref=e360]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" deps: React"
      - generic [ref=e361]:
        - generic [ref=e362]:
          - generic [ref=e363]: 11:32:02.455
          - generic [ref=e364]: DEBUG
        - generic [ref=e365]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" commands (`"
      - generic [ref=e366]:
        - generic [ref=e367]:
          - generic [ref=e368]: 11:32:03.027
          - generic [ref=e369]: DEBUG
        - generic [ref=e370]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\", etc.), con"
      - generic [ref=e371]:
        - generic [ref=e372]:
          - generic [ref=e373]: 11:32:03.646
          - generic [ref=e374]: DEBUG
        - generic [ref=e375]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\".md summary:"
      - generic [ref=e376]:
        - generic [ref=e377]:
          - generic [ref=e378]: 11:32:04.226
          - generic [ref=e379]: DEBUG
        - generic [ref=e380]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ionally runs"
      - generic [ref=e381]:
        - generic [ref=e382]:
          - generic [ref=e383]: 11:32:04.787
          - generic [ref=e384]: DEBUG
        - generic [ref=e385]: "event: stream_event {\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" for multi-c"
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { waitForApp } from './helpers';
  3  | 
  4  | test.describe('send while streaming', () => {
  5  |   test.beforeEach(async ({ page }) => {
  6  |     await waitForApp(page);
  7  |     // Start each test in a clean session. Integration tests share a channel entry
  8  |     // (same workspace dir, fresh=false), so replayed history from a previous test
  9  |     // contains completed timers that cause false-positive checks (e.g. timer.last()
  10 |     // matches an old turn before the current one finishes). newSession resets the
  11 |     // entry state and kills any orphaned CLI from a prior timeout, preventing cascade.
  12 |     await page.getByRole('button', { name: 'New chat' }).click();
  13 |     await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 5_000 });
  14 |   });
  15 | 
  16 |   test('second message sent during streaming appears as inline inject', async ({ page }) => {
  17 |     const textarea = page.getByPlaceholder('Ask Argus');
  18 | 
  19 |     // Send a task long enough to leave room for a mid-turn inject.
  20 |     await textarea.fill('Read package.json, then read CLAUDE.md, then summarize both.');
  21 |     await page.getByRole('button', { name: 'Send' }).click();
  22 | 
  23 |     // Gate on the Stop button, not on a tool call: whether the model actually calls a
  24 |     // tool (and how fast) is its own choice, so a toolCall locator is a model-dependent
  25 |     // proxy that intermittently never appears. Stop is rendered for every active turn,
  26 |     // which is exactly the precondition here - the turn is still in flight.
  27 |     await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
  28 | 
  29 |     // Inject second message while the turn is still running
  30 |     await textarea.fill('What is 123 + 456? Reply with just the number.');
  31 |     await page.getByRole('button', { name: 'Send' }).click();
  32 | 
  33 |     // Wait for the whole turn (including the inject) to complete. We gate on the Stop
  34 |     // button disappearing rather than timer.first(): timer.first() could match a timer
  35 |     // from a replayed prior turn and produce a false positive before the CLI finishes.
> 36 |     await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 90_000 });
     |                                                              ^ Error: expect(locator).toHaveCount(expected) failed
  37 | 
  38 |     // The injected user message should appear inline as a userInject block
  39 |     const inject = page.locator('div[class*="userInject"]');
  40 |     await expect(inject).toBeVisible();
  41 |     await expect(inject).toContainText('123 + 456');
  42 | 
  43 |     // No error blocks
  44 |     const errorBlock = page.locator('[class*="errorBlock"]');
  45 |     await expect(errorBlock).toHaveCount(0);
  46 |   });
  47 | 
  48 |   test('can send normally after mid-turn inject completes', async ({ page }) => {
  49 |     const textarea = page.getByPlaceholder('Ask Argus');
  50 | 
  51 |     // First: a task with tool calls
  52 |     await textarea.fill('Read package.json and tell me the version number.');
  53 |     await page.getByRole('button', { name: 'Send' }).click();
  54 | 
  55 |     // Gate on the Stop button rather than a tool call - see the note in the test above:
  56 |     // a toolCall locator depends on the model choosing to call a tool, Stop does not.
  57 |     const stopBtn = page.getByRole('button', { name: 'Stop' });
  58 |     await expect(stopBtn).toBeVisible({ timeout: 30_000 });
  59 | 
  60 |     // Inject a short question mid-turn
  61 |     await textarea.fill('Say "scub-inject-ok" and nothing else.');
  62 |     await page.getByRole('button', { name: 'Send' }).click();
  63 | 
  64 |     // Wait for the whole turn (inject included) to complete. We gate on the Stop button
  65 |     // disappearing rather than timer.last(): timer.last() can match a timer from a
  66 |     // replayed older turn and return a false positive before the current CLI turn
  67 |     // finishes. That false positive would cause the follow-up send to arrive mid-turn
  68 |     // as a second inject, inflating the combined CLI work past the 90s test timeout.
  69 |     await expect(stopBtn).toHaveCount(0, { timeout: 60_000 });
  70 | 
  71 |     // Inject should be visible
  72 |     const inject = page.locator('div[class*="userInject"]');
  73 |     await expect(inject).toBeVisible();
  74 | 
  75 |     // Now send a regular follow-up (between turns, not mid-turn)
  76 |     await textarea.fill('Say "scub-followup-ok" and nothing else.');
  77 |     await page.getByRole('button', { name: 'Send' }).click();
  78 | 
  79 |     // Wait for the follow-up turn to start (Stop button appears), then complete (Stop gone)
  80 |     await expect(stopBtn).toBeVisible({ timeout: 30_000 });
  81 |     await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });
  82 | 
  83 |     // Now we have at least 2 timers - assert the follow-up text is present
  84 |     await expect(page.getByText('scub-followup-ok').first()).toBeVisible({ timeout: 10_000 });
  85 | 
  86 |     // No error blocks
  87 |     const errorBlock = page.locator('[class*="errorBlock"]');
  88 |     await expect(errorBlock).toHaveCount(0);
  89 |   });
  90 | });
  91 | 
```