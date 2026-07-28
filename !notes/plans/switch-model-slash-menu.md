# Switch model... in slash menu

**Status: implemented**

Add a "Switch model..." entry to the `/` slash menu's "Model" section, matching the Claude Code UI. Shows the current model name right-aligned (e.g., "Sonnet"), clicking opens an inline model picker.

## Files to change

| File | Change |
|------|--------|
| `src/backend/session.ts` | Add model to `workspaceInfo` response; add `switchModel` handler that updates `s.model` + writes config |
| `webview/src/reducer.ts` | Add `currentModel` to state; handle `workspaceInfo` and `modelChanged` |
| `webview/src/App.tsx` | Pass `currentModel` to `InputArea` |
| `webview/src/components/InputArea.tsx` | Add `showModelAction`, `modelPickerOpen` state, "Switch model..." item + inline picker, index accounting |
| `webview/src/components/InputArea.module.css` | Add `.slashMenuCheck` if needed |

---

## 1. Backend: expose current model + handle switchModel

**`src/backend/session.ts`**

In the `getInfo` handler (around line 168), extend the `workspaceInfo` response:
```ts
ws.send(JSON.stringify({ type: 'workspaceInfo', path: ..., version: ..., model: s.model }));
```

Add a new `switchModel` handler:
```ts
else if (msg.type === 'switchModel') {
  const { model } = msg as { model: string };
  s.model = model ?? '';
  await writeConfig({ ...readConfig(), model: s.model });
  ws.send(JSON.stringify({ type: 'modelChanged', model: s.model }));
}
```

---

## 2. Reducer: track currentModel

**`webview/src/reducer.ts`**

- Add `currentModel: string` to `AppState` (init `''`)
- In `workspaceInfo` action: set `state.currentModel = action.model ?? ''`
- Add `modelChanged` action: `state.currentModel = action.model ?? ''`

**`webview/src/App.tsx`**

Pass `currentModel={state.currentModel}` to `InputArea`.

---

## 3. Slash menu: "Switch model..." item

**`webview/src/components/InputArea.tsx`**

Trigger logic (alongside existing `showAccountAction`):
```ts
const showModelAction = accountQuery.length > 0 && (
  'model'.startsWith(accountQuery) || 'switch'.startsWith(accountQuery)
);
const modelActionIndex = filteredSkills.length;
const accountActionIndex = filteredSkills.length + (showModelAction ? 1 : 0);
const totalDropdownItems = filteredSkills.length + (showModelAction ? 1 : 0) + (showAccountAction ? 1 : 0);
```

Render the "Model" section header when either action is visible:
```tsx
{(showModelAction || showAccountAction) && (
  <div className={styles.slashMenuHeader}>Model</div>
)}
{showModelAction && (
  <div className={[styles.slashMenuItem, highlightIndex === modelActionIndex ? styles.slashMenuItemActive : ''].filter(Boolean).join(' ')}
    onMouseDown={e => e.preventDefault()}
    onClick={() => setModelPickerOpen(v => !v)}
  >
    <span className={styles.slashMenuName}>Switch model...</span>
    <span className={styles.slashMenuHint}>{currentModelShort}</span>
  </div>
)}
{showModelAction && modelPickerOpen && KNOWN_MODELS.map(m => (
  <div key={m.id} className={styles.slashMenuItem} onMouseDown={e => e.preventDefault()} onClick={() => pickModel(m.id)}>
    <span className={styles.slashMenuCheck}>{m.id === currentModel ? '✓' : ''}</span>
    <span className={styles.slashMenuName}>{m.label}</span>
  </div>
))}
```

State:
```ts
const [modelPickerOpen, setModelPickerOpen] = React.useState(false);
```

Model list (module-level constant):
```ts
const KNOWN_MODELS = [
  { id: '',                    label: 'Default (CLI)',     short: 'Default' },
  { id: 'claude-haiku-4-5',   label: 'Claude Haiku 4.5',  short: 'Haiku'   },
  { id: 'claude-sonnet-4-6',  label: 'Claude Sonnet 4.6', short: 'Sonnet'  },
  { id: 'claude-opus-4-8',    label: 'Claude Opus 4.8',   short: 'Opus'    },
];
```

Derived short label:
```ts
const currentModelShort = KNOWN_MODELS.find(m => m.id === currentModel)?.short ?? currentModel ?? 'Default';
```

`pickModel` handler:
```ts
function pickModel(id: string) {
  postMessage({ type: 'switchModel', model: id });
  setModelPickerOpen(false);
  setSlashQuery(null);
  clearSlashFromInput();
}
```

---

## 4. Message protocol

- `switchModel` routes over WS bridge (not `VS_ONLY`) - no ChatPanel change needed
- `modelChanged` arrives via WS and handled by reducer

Update `WebviewMessage` union in `ChatPanel.ts` to add `modelChanged` to the outbound list (comment only, for documentation).

---

## Notes

- The "Model" header currently belongs to `showAccountAction` alone (line 394 in InputArea.tsx). Decouple it so it shows for either action.
- `modelPickerOpen` should reset to `false` when `slashQuery` becomes `null`.
- Keyboard navigation: model picker rows should participate in the `highlightIndex` / `totalDropdownItems` count (extend the index accounting).
- The model change takes effect on the **next sent message** (same turn already in progress uses the old model).
