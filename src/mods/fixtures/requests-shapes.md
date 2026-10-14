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

## Run 3 (lot 0a, 10/10, claude 2.1.291) — éléments `Svg` et `Client`

Fixtures : `client-render.ndjson` (réponse `ui_render` d'un Pane contenant un nœud `Client`, **anonymisée**), `client-module.json` (réponse `ui_client_module`, dont les `files` sont NOS sources factices), `client-roundtrips.ndjson` (réponses mesurées de `ui_message` / `ui_client_fault` / `ui_client_press` + push), `client-stub/` (runtime factice `runtime.js` qui respecte le contrat `install(host, limits)`, `module.js`, `module-loop.js` qui boucle, `module-throw.js` qui lève). Ni le code d'un plugin tiers ni le runtime du moteur ne sont dans le dépôt.

- **Svg** (`ui_render`, nœud `{type:"Svg", props:{source, alt, width?, height?, isInteractive?}}`) : `source` ≤ 131 072 caractères ; `alt` obligatoire ; `isInteractive` → cadre sans script. Un Svg n'est pas autorisé DANS un `Client` (le runtime n'offre que Box, Text, Button, Input, Select, Link, Code, Markdown).
- **Nœud Client** : `{type:"Client", props:{key, module, props?, width?, height?}, client:{plugin}}` ; `props.props` est un OBJET (JSON), pas une chaîne. La réponse `ui_render` porte `client_modules: {<plugin>: <hash>}` ; un plugin absent de ce record n'a pas de module de surface chargé.
- **`ui_client_module {plugin}`** → `{plugin, hash, modules:[{module:"hooks/rows.tsx", entry:"surface:///hooks/rows.tsx", component:"default"}], runtime:"claude:surface-runtime", limits:{nodes,depth,chars,values,dataDepth}, files:[{key, source}]}`. Les `files` sont du **JavaScript déjà compilé** (un fichier par module ES) : `claude:surface-runtime` (~31 Ko), `claude:hooks-types` (~4 Ko), `surface:///<chemin>`. Un module compilé n'a pas d'`import` (il utilise `h` en global et finit par `export default`) ; les imports éventuels vers d'autres fichiers du plugin sont des clés d'import-map (`surface:///…`).
- **Contrat du runtime** (lu dans le runtime servi) : le module `claude:surface-runtime` exporte `h`, `Fragment` et `install(host, limits)`. Le cadre pose `globalThis.h/Fragment` AVANT d'importer une entrée. `host` fournit `schedule(id)`, `startTimer(id, ms) → timerId`, `stopTimer(id, timerId)`, `post(id, jsonText)`, `fault(id, reason)` (optionnel). `install` retourne `{mount(id, fn, props), setProps(id, props), resize(id, columns, rows), stage(id, kind, payload), dropHeld(id, handles), hasListener(id, 'pointer'|'key'), unmount(id)}`. Chaque appel : `stage(id, kind, payload)` puis `globalThis.__surface__.run()`. `kind` : `render` (retourne le TEXTE JSON de l'arbre), `pointer` ({type:'down'|'move'|'up'|'enter'|'leave', x, y, button?, shift?, alt?, ctrl?}, cellules relatives à la région), `key` ({key, ctrl?, shift?, meta?}), `tick` (timerId), `held` ({handle, event}).
- **Arbre exporté par un module** : `{type, props?, hover?, children?}` ; `Button`, `Input`, `Select` sortent avec `held:<n>` (pas d'enfants, callback gardé dans le runtime). `dropHeld` libère les handles des éléments retirés d'un redessin. Limites : 20 000 nœuds, profondeur 32, 100 000 caractères sérialisés, 1 s par appel (budget moteur).
- **`ui_message`** `{plugin, component, instance_id, client:<key>, module:<chemin>, data}` → `{handled}` (+ `props?` à repasser au module via `setProps`). **`ui_client_fault`** `{…adresse, phase:"load"|"render"|"run", reason}` → `{handled}`. **`ui_client_press`** `{…adresse, element, event:{type:"press"}|{type:"input",kind,value}|{type:"select",value}}` → `{handled, reached?}` ; `reached` absent = un hook a bloqué. L'adresse n'a PAS de champ `surface`.
- **Mesuré avec un vrai plugin (pane de fichiers)** : `ui_message {scrollTo}`, `{key}`, `{press}` → `{handled:true}` et des `ui_invalidate` du Pane ; `ui_client_fault` → `{handled:true}` puis `ui_invalidate` (le moteur redessine le site). Un module qui boucle est coupé après 1 s côté moteur ; Den doit tenir le même budget (Worker + `terminate()`).

## Lot 0 DEN-32 phase 3 (14/10, claude 2.1.296) — prismantis sur 7 surfaces

Sondes : `sidecar/src/modSurface.e2e.test.ts` (`DEN_E2E_MODS=1`, bloc « sondes prismantis »), zéro tour modèle (slash commands + `ui_render` direct écrit à la main, car `ModSurface` n'envoie pas encore `viewport`). prismantis chargé via `CLAUDE_CODE_PLUGIN_DIRS` (liste de settings.json + son répertoire) ; config utilisateur : thème tokyo-night, promptStyle bubble, clock 24h, toolStyle chat, toolOutput full. Fixtures :
- `prismantis-render-matrix.ndjson` : 15 entrées × 5 variantes de viewport + 3 sondes de seuil = 78 lignes `{label, request, engineResponse, denMessage}`. `engineResponse` = résultat moteur verbatim (`{tree, props, rewritten, hooked}`), `denMessage` = ce que `ModSurface` en fait aujourd'hui (il **abandonne `props`**).
- `prismantis-element-types.json` : recensement des types d'éléments et clés de props sur ces 78 arbres.
- `prismantis-commands.ndjson` : messages SDK reçus pour `/prismantis demo` et `/cost` (init retiré ; texte et `usage_report` de `/cost` expurgés, forme conservée).
- `prismantis-props-rewrite.ndjson` : passages `next(e)` (réécriture de props), 9 lignes.

### 1. Les 7 surfaces sur desktop

Toutes : `hooked:true`, `props` renvoyé (identique à la requête dans 78/78 cas), clés de réponse exactement `tree, props, rewritten, hooked`. Aucune erreur.

| Surface (entrée) | Arbre | rewritten |
|---|---|---|
| AssistantMessage tableau / code / mermaid flowchart / riche / diagrammes | `Box` (puce ● + colonne), boutons `⧉ md`, `⧉ art`, `⧉ copy` (avec `press`) | false |
| ToolResult Edit (structuredPatch 1 hunk) | `Box` (« ⎿ » + carte de diff) | false |
| ToolResult Bash | `{type:"engine",ref:1}` + props identiques | **true** |
| UserMessage (origin composer) | `Box` bordure `round` (bulle) | false |
| ToolUse Bash / Edit | `Box` ligne droite (`justifyContent:"flex-end"`, `width:"100%"`, enfant `width` = longueur du texte) + ` ●` | false |
| ToolGroup (calls: 3 Read) | `Box` une ligne « Read 3 files · last: … ● » (`wrap:"truncate-end"`) | false |
| CommandOutput | `Box` colonne, markdown de prismantis (tableaux avec boutons) | false |
| TurnDuration | `Text` « ✻ Baked for 6s » (durationMs 6340 → « 6s ») | false |

### 2. Effet de `viewport`

Variantes : sans viewport, 60, 96, 120 colonnes (rows 40, isFullscreen false) et 120 avec isFullscreen true ; comparaison après normalisation des `press.handle` (qui changent à chaque rendu).
- **Sans effet** (arbres identiques sur toutes les variantes) : tableau / code / mermaid de la taille de l'exemple, UserMessage, ToolUse, ToolResult Bash, CommandOutput, TurnDuration, `isFullscreen` (120 vs 120fs : identique partout).
- **Effet réel** : tableau large (5 colonnes longues) : bordure de 22 caractères par colonne à 120, 18 (17 sur 4 colonnes) à 96, 10 à 60 (arbres de 9 500 / 11 225 / 13 942 caractères) ; sans viewport = colonnes de 18 (≈ comportement 96, pas identique à 120). ToolGroup : largeur de l'enfant 36 à 60 colonnes, 43 à 96/120/sans viewport.
- Mermaid large (5 étapes en chaîne) : identique de 60 à 120 (non discriminant).
- **files-pane, ToolResult Edit** : 143 colonnes → carte de diff prismantis (`Box`, 2 491 car.) ; **144 → `Text` dimColor « ↳ diff dans le pane Review (/review-diff) »** (98 car.). Fichier du vault à 144 : la carte reste (2 491 car.). Sans viewport : carte (`columns ?? 0` < 144). Seuil confirmé 143/144.

### 3. TurnDuration depuis desktop

**Accepté**, pas d'erreur, pas de `hooked:false` : `{tree:{type:"Text",props:{color:"#565f89"},children:["✻ Baked for ",{type:"Text",props:{color:"#ff9e64"},children:["6s"]}]}, props:{word:"Baked",durationMs:6340}, rewritten:false, hooked:true}`. Le contrat des types du moteur dit « Raised on the terminal surface only » : la requête `ui_render` desktop n'est pas refusée pour autant. Ce qui n'est pas mesuré : si le moteur envoie lui-même un TurnDuration à une surface desktop en fin de tour (il faudrait un tour modèle) ; seule la requête explicite de Den est prouvée.

### 4. Types d'éléments et clés de props réellement vus (78 arbres)

Types : **Box, Text, Button, Link** (+ `engine` quand rien n'est dessiné). Jamais vus : Markdown, Code, Input, Select, Svg, Client (prismantis dessine tout lui-même).
- `Box` : flexDirection, width, flexShrink, flexGrow, rowGap, columnGap, key, alignSelf, alignItems, justifyContent, flexWrap ("wrap"), paddingLeft, paddingX, borderStyle ("round"), borderColor, backgroundColor. Enfants : Box, Text, Button.
- `Text` : color, dimColor, bold, italic, strikethrough, underline, wrap ("truncate-end"). Enfants : chaînes, Text, Link. Valeurs `color` : hex (`#bb9af7`) ; `borderColor` vu aussi `"yellow"`.
- `Button` : key, label, variant ("primary") ; `press:{plugin:"prismantis",handle}` au niveau du nœud ; pas d'enfants.
- `Link` : href seul, **enfant `Text`** (le libellé est dans l'enfant, pas dans `props`) ; pas de `press` dans cet échantillon.
- Absents du recensement (donc non mesurés ici) : width en pourcentage sur Box autre que `"100%"` (vu sur ToolUse/ToolGroup), `minWidth`, `rowGap` sur Text, `ansi256()`, `overflow`, `position`.

### 5. Commandes slash — forme des messages SDK

Aucun `system/local_command_output` n'a été reçu (ni pour la commande de mod, ni pour la commande native). Séquence identique pour `/prismantis demo` et `/cost` (sans tour modèle) :
1. `system/init` ;
2. un message **`type:"assistant"`** : `message.model:"<synthetic>"`, `message.content:[{type:"text",text:<sortie>}]`, `parent_tool_use_id:null`, `local_command_source:"<local-command-stdout>…"` (la sortie entourée de la balise ; 6 015 car. pour la démo), `local_command_run:{command,args}` (`{"command":"prismantis","args":"demo"}` ; pour `/cost` : `{"command":"usage","args":""}` — la commande est **renommée** par le moteur), `timestamp`, et pour `/cost` un `usage_report` ;
3. un **`result`** `subtype:"success"` à t+0 ms (`num_turns:0`, `total_cost_usd:0`, `is_error:false`) avec `result:<même texte>` et `local_command:"custom"` (mod) ou `"cost"` (natif).
Le `result` suit bien. Le texte contient la balise `<local-command-stdout>` dans `local_command_source` mais pas dans `message.content[0].text`.

### 6. bash-gate (`$.ui.ask`)

**Non mesurable sans tour modèle.** bash-gate ne s'accroche qu'à `tool.call` de Bash (`hooks/register.ts`), déclenché par un appel d'outil du modèle ; aucune requête de contrôle `ui_*` ne simule `tool.call`. Aucun mod chargé n'appelle `ui.ask` depuis une commande. Les types du moteur disent seulement que `ui.ask` passe par le dialogue AskUserQuestion (`ui.render` composant `AskUserQuestion`, « raised on every surface »).

### 7. Réécriture de props `{tree:{type:"engine",ref:N}, props}`

Forme exacte mesurée : `{"tree":{"type":"engine","ref":1},"props":{…props, identiques à l'entrée…},"rewritten":true,"hooked":true}`.
- Produite à chaque fois qu'un hook de prismantis fait `next(e)` : ToolResult Bash, ToolResult Read, ToolResult Edit en erreur, CommandOutput en erreur, UserMessage d'origine `peer`, UserMessage avec `promptStyle: off` (réglage injecté via l'option `settings` du SDK, sans toucher à la config), ToolGroup `isExpanded:true`, ToolUse Read dans un groupe déplié : **9/9 `ref:1`, `rewritten:true`, props identiques à la requête**. Avec les seuls mods de l'utilisateur (fixture `responses-render.ndjson`, ToolResult Read) : `ref:0`, `rewritten:false`. Sémantique de `ref` : `0` = « original du moteur » (déjà documenté) ; `1` observé ici avec prismantis chargé, rien de plus n'est prouvé.
- **Non mesuré** : une réécriture qui *change* les props (ex. UserMessage `[14:32] texte` quand `clock` ≠ off et `promptStyle` = off). Le hook ne réécrit que si l'heure d'envoi est connue (enregistrée sur `prompt.submit` d'un vrai prompt) ; `/prismantis demo` ne l'a pas enregistrée (props renvoyées inchangées). Il faut un tour modèle.
- `ModSurface.reply` ne relaie pas `props` aujourd'hui (`modSurface.ts:360-369`) : Den ne peut pas encore redessiner une réécriture.
