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

## Run 2 (lot 0a, 09/10, claude 2.1.291) — panes, copie, résultat d'outil

Fixtures : `run2-panes.ndjson` (roster, arbres réels files-pane / daily-todos [texte anonymisé] / handoff-copy, pushes, show/focus/close), `run2-copy.ndjson` (requête moteur→client `ui_copy` + réponse), `tool-use-result-read.json`.

- **Roster** : requête `ui_panes {client_id?}` → `{panes:[{id,title,plugin,close_on_escape?,rows?}], shown_id, focused_id, focus_requested_id}` ; même forme en push `system/ui_panes` (liste COMPLÈTE, plusieurs pushes par ouverture). `focus_requested_id` = le mod demande le focus (daily-todos) : l'honorer.
- **Pane** : `ui_render {component:"Pane", instance_id:<id du pane>, props:{title,isFocused,bodyColumns,placement:"dock",scroll:{offset,bodyRows},view:{}}}`. Props d'arbre vus en plus : `dimColor`, `marginTop`, `marginLeft`, `color:"cyan"`, enfants texte en tableaux (`["0"," modifié(s) · ","1"," lu(s)"]`).
- **Actions client→moteur** : `ui_pane_show {id}` → `{shown_id}` · `ui_pane_focus {id}` → `{focused_id}` · `ui_close {id}` → `{closed:true}` puis push `ui_panes` sans ce pane.
- **`ui_press` est long** : sa réponse `{handled,element}` n'arrive qu'à la fin du handler du mod (Copier de handoff-copy = un `model.fork`, plusieurs secondes). Pendant ce temps : push `ui_toast` (« Handoff en préparation… », 15 s) + `ui_invalidate`. **Prévoir un timeout long (≥ 90 s) pour les presses**, pas les 10 s des rendus.
- **`ui_copy` (moteur→client)** : seulement si `answers:["ui_copy"]` à l'attache. Arrive sur le stdout du `claude` comme `{type:"control_request",request_id:<uuid>,request:{subtype:"ui_copy",surface,client_id,plugin,text}}`. Réponse sur stdin : `{type:"control_response",response:{subtype:"success",request_id:<même uuid>,response:{copied:true}}}`. **Course avec le SDK mesurée : OK** — le SDK répond « error » au même request_id, le moteur l'ignore et accepte la réponse success de Den ; le mod a affiché « Handoff copié (1117 caractères). ».
- **`tool_use_result`** (message SDK `user`) pour `Read` : `{type:"text",file:{filePath,content,numLines,startLine,totalLines}}` — même forme que la fixture ToolResult, plus `startLine`/`totalLines`.
