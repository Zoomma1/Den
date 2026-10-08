# Formes de requêtes mesurées (claude 2.1.291, DEN-32 lot 0a) — canal stdio stream-json

Toutes : `{"type":"control_request","request_id":"den-ui-<n>","request":{ "subtype": ..., ... }}`.

- `ui_attach` : `surface` ("desktop"), `client_id` (1-64 de [A-Za-z0-9._-], PAS de `:`), `viewport?`, `answers?` (liste parmi ui_copy, ui_prompt_read, ui_prompt_fill, ui_prompt_suggest, ui_read_selection) → `{surfaces:["desktop"]}`
- `ui_detach` : `surface`, `client_id` → `{detached:true, surfaces:[]}`
- `ui_render` : `surface`, `client_id`, `component`, `instance_id` (string), `props` (objet), `viewport?`, `on_screen?` → `{tree, props, rewritten, hooked}`
  - `component` : AssistantMessage {text,isFirstOfReply} · ToolResult {tool_use_id,tool,output,isErrored} · AbovePrompt {hasSurvey,isWorking,maxRows,bodyColumns,scroll:{offset,bodyRows},view:{}} · Pane {title,isFocused,bodyColumns,placement:"dock"|"inline",scroll,view:{}} ; `instance_id` d'un Pane = l'id du pane (cf. push `ui_panes`).
  - `tree.type === "engine"` + `ref: 0` = « dessine l'original » (le moteur ne réécrit pas) ; `hooked:false` = aucun mod.
- `ui_press` : `plugin`, `handle` (entier, lu dans `node.press.handle`), `key?`, `surface?`, `href?` → `{handled, element}`
- `ui_input` : `plugin`, `handle`, `kind` ("change"|"submit"), `value` (≤16384), `key?`, `component?`, `instance_id?`, `surface?` → `{handled, element, value}`
- `ui_select` : `plugin`, `handle`, `value`, `key?`, `component?`, `instance_id?`, `surface?`

Nœuds interactifs (Button, Input, Select, Link markdown) : `{"type":"Button","props":{key,label,variant,role},"press":{"plugin":"…","handle":429363471}}` — `press` est au niveau du nœud, pas dans `props`.

Pushes `system` (sans demande) : `ui_status {plugin,text}` · `ui_toast {plugin,text,timeout_ms}` · `ui_panes {panes:[{id,title,plugin,rows?}],shown_id,focused_id,focus_requested_id}` (liste COMPLÈTE, vide = tout fermé) · `ui_invalidate {event:"ui.render",instances:[{surface,component,instance_id}]}` → re-demander ces instances.

Événements mesurés en session SDK avec le `claude` système : session.start, turn.start, tool.call, turn.complete (+ commandes de mod via prompt `/files`, `/hpane`). `ui.render` uniquement via `ui_render` d'une surface attachée.
