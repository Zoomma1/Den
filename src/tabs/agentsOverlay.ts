import "./agentsOverlay.css";
import { IncrementalMarkdownRenderer } from "../markdown/renderer";
import { MAX_STEPS, type Subagent, type SubagentStepView, type Subagents, workflowLine } from "./subagents";

export interface AgentsOverlay {
  triggerEl: HTMLButtonElement;
  setAgents(list: Subagents): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

const STATUS_LABEL: Record<Subagent["status"], string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Écrire seulement si la valeur change : préserve une sélection de texte en cours.
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

/** Titre d'un pli : libellé + aperçu d'une ligne, pour scanner sans déplier. */
function foldSummary(label: string, text: string, truncated: boolean): HTMLElement {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 90);
  const summary = el("summary", "den-agents-step__name", label);
  if (preview) summary.append(el("span", "den-agents-step__preview", preview));
  // Dans la ligne du résumé : après le <pre>, la mention tombait sur sa propre ligne.
  if (truncated) summary.append(el("span", "den-agents-step__truncated", "(truncated)"));
  return summary;
}

function renderStep(step: SubagentStepView): HTMLElement {
  let node: HTMLElement;
  if (step.kind === "text") {
    node = el("p", "den-agents-step den-agents-step--text", step.text);
  } else if (step.kind === "tool_use") {
    node = el("details", "den-agents-step den-agents-step--tool");
    node.append(foldSummary(step.name ?? "tool", step.text, step.truncated), el("pre", "den-agents-step__pre", step.text));
  } else {
    // Replié : un résultat peut peser 4000 caractères, c'est lui qui fabrique le « pavé ».
    node = el("details", "den-agents-step den-agents-step--result");
    if (step.isError) node.classList.add("den-agents-step--error");
    node.append(foldSummary(step.isError ? "Error" : "Result", step.text, step.truncated), el("pre", "den-agents-step__pre", step.text));
  }
  if (step.truncated && step.kind === "text") {
    node.append(document.createTextNode(" "), el("span", "den-agents-step__truncated", "(truncated)"));
  }
  return node;
}

interface PhaseNode {
  root: HTMLElement;
  title: HTMLElement;
  list: HTMLElement;
}
interface AgentNode {
  root: HTMLDetailsElement;
  label: HTMLElement;
  prompt: HTMLElement;
  task: HTMLElement;
  meta: HTMLElement;
  result: HTMLElement;
  resultText: HTMLElement;
}

function makePhaseNode(): PhaseNode {
  const title = el("h5", "den-agents-phase__title");
  const list = el("div", "den-agents-phase__agents");
  const root = el("section", "den-agents-phase");
  root.append(title, list);
  return { root, title, list };
}

// <details> natif : Entrée/Espace sur le <summary> et l'état ouvert survivent à la mise à jour en place.
function makeAgentNode(): AgentNode {
  const label = el("span", "den-agents-wf-agent__label");
  const prompt = el("span", "den-agents-wf-agent__prompt");
  const summary = el("summary", "den-agents-wf-agent__head");
  summary.append(el("span", "den-agents-wf-agent__dot"), label, prompt);
  const task = el("pre", "den-agents-wf-agent__task");
  const meta = el("p", "den-agents-wf-agent__meta");
  const resultText = el("pre", "den-agents-wf-agent__task");
  const result = el("div", "den-agents-wf-agent__result");
  result.append(el("strong", "den-agents-wf-agent__caption", "Result"), resultText);
  const body = el("div", "den-agents-wf-agent__body");
  body.append(el("strong", "den-agents-wf-agent__caption", "Task (preview)"), task, meta, result);
  const root = el("details", "den-agents-wf-agent");
  root.append(summary, body);
  return { root, label, prompt, task, meta, result, resultText };
}

export function createAgentsOverlay(host: HTMLElement): AgentsOverlay {
  const triggerEl = document.createElement("button");
  triggerEl.type = "button";
  triggerEl.className = "den-agents-trigger";
  const badgeEl = el("span", "den-agents-trigger__badge");
  badgeEl.hidden = true;
  triggerEl.append(el("span", "", "Agents"), badgeEl);

  const backdrop = el("div", "den-agents-backdrop");
  backdrop.hidden = true;
  const dialog = el("div", "den-agents-overlay");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Agents");
  dialog.tabIndex = -1;
  const listEl = el("div", "den-agents-overlay__list");
  const detailEl = el("div", "den-agents-overlay__detail");
  dialog.append(listEl, detailEl);
  backdrop.append(dialog);
  host.append(backdrop);

  const rows = new Map<string, HTMLButtonElement>();
  let agents: Subagents | null = null;
  let selectedId: string | null = null;
  let opened = false;
  let previousFocus: HTMLElement | null = null;

  // Volet détail : reconstruit seulement quand l'agent affiché change.
  let shownId: string | null = null;
  let renderedCount = 0;
  let renderedReport: string | undefined;
  let taskEl: HTMLDetailsElement;
  let promptEl: HTMLElement;
  let phasesHeadEl: HTMLElement;
  let phasesEl: HTMLElement;
  let stepsHeadEl: HTMLElement;
  let stepsEl: HTMLElement;
  let phaseNodes = new Map<number, PhaseNode>();
  let agentNodes = new Map<number, AgentNode>();
  let reportEl: HTMLElement;

  function rowText(a: Subagent): string {
    if (a.workflow || a.workflowName) return workflowLine(a);
    const u = a.usage;
    return [
      a.subagentType ?? "agent",
      a.description,
      STATUS_LABEL[a.status],
      u ? formatDuration(u.durationMs) : "",
      u ? formatTokens(u.totalTokens) : "",
    ]
      .filter((p) => p)
      .join(" · ");
  }

  function renderReport(text: string): void {
    reportEl.replaceChildren(el("strong", "den-agents-report__label", "Report"));
    const body = el("div", "den-msg-finalized");
    const renderer = new IncrementalMarkdownRenderer();
    for (const html of [...renderer.feed(text).finalizedHtml, ...renderer.finalize()]) {
      const t = document.createElement("template");
      t.innerHTML = html;
      body.appendChild(t.content);
    }
    reportEl.appendChild(body);
  }

  function resetDetail(a: Subagent): void {
    taskEl = el("details", "den-agents-task");
    promptEl = el("p", "den-agents-task__prompt");
    taskEl.append(el("summary", "", "Task"), promptEl);
    phasesHeadEl = el("h4", "den-agents-section", "Phases");
    phasesEl = el("div", "den-agents-phases");
    phasesHeadEl.hidden = phasesEl.hidden = true;
    stepsHeadEl = el("h4", "den-agents-section", "Steps");
    stepsEl = el("div", "den-agents-steps");
    reportEl = el("div", "den-agents-report");
    phaseNodes = new Map();
    agentNodes = new Map();
    detailEl.replaceChildren(taskEl, phasesHeadEl, phasesEl, stepsHeadEl, stepsEl, reportEl);
    shownId = a.taskId;
    renderedCount = 0;
    renderedReport = undefined;
    reportEl.hidden = true;
    detailEl.scrollTop = 0;
  }

  // Nœuds réutilisés par index de phase / d'agent : un progress ne reconstruit rien.
  function syncWorkflow(wf: NonNullable<Subagent["workflow"]>): void {
    const phaseIdx = new Set(wf.phases.map((p) => p.index));
    const phases = [...wf.phases].sort((x, y) => x.index - y.index);
    for (const ag of wf.agents) {
      if (!phaseIdx.has(ag.phaseIndex)) {
        phaseIdx.add(ag.phaseIndex);
        phases.push({ index: ag.phaseIndex, title: `Phase ${ag.phaseIndex}` });
      }
    }
    const seenAgents = new Set<number>();
    phases.forEach((p, pi) => {
      let pn = phaseNodes.get(p.index);
      if (!pn) {
        pn = makePhaseNode();
        phaseNodes.set(p.index, pn);
      }
      setText(pn.title, p.title);
      if (phasesEl.children[pi] !== pn.root) phasesEl.insertBefore(pn.root, phasesEl.children[pi] ?? null);
      const mine = wf.agents.filter((x) => x.phaseIndex === p.index).sort((x, y) => x.index - y.index);
      mine.forEach((ag, ai) => {
        seenAgents.add(ag.index);
        let an = agentNodes.get(ag.index);
        if (!an) {
          an = makeAgentNode();
          agentNodes.set(ag.index, an);
        }
        an.root.dataset.state = ag.state;
        setText(an.label, ag.label);
        setText(an.prompt, (ag.promptPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 90));
        setText(an.task, ag.promptPreview ?? "");
        setText(
          an.meta,
          [
            ag.state,
            ag.model,
            ag.durationMs !== undefined ? formatDuration(ag.durationMs) : "",
            ag.tokens !== undefined ? formatTokens(ag.tokens) : "",
            ag.toolCalls !== undefined ? `${ag.toolCalls} tool ${ag.toolCalls === 1 ? "call" : "calls"}` : "",
          ]
            .filter((p) => p)
            .join(" · "),
        );
        an.result.hidden = ag.resultPreview === undefined;
        setText(an.resultText, ag.resultPreview ?? "");
        if (pn.list.children[ai] !== an.root) pn.list.insertBefore(an.root, pn.list.children[ai] ?? null);
      });
    });
    const seenPhases = new Set(phases.map((p) => p.index));
    for (const [i, n] of phaseNodes) {
      if (seenPhases.has(i)) continue;
      n.root.remove();
      phaseNodes.delete(i);
    }
    for (const [i, n] of agentNodes) {
      if (seenAgents.has(i)) continue;
      n.root.remove();
      agentNodes.delete(i);
    }
  }

  function updateDetail(a: Subagent): void {
    const fresh = shownId !== a.taskId;
    if (fresh) resetDetail(a);
    const atBottom = !fresh && detailEl.scrollHeight - detailEl.scrollTop - detailEl.clientHeight <= 8;
    setText(promptEl, a.prompt ?? "");
    taskEl.hidden = a.prompt === undefined;
    phasesHeadEl.hidden = phasesEl.hidden = a.workflow === undefined;
    if (a.workflow) syncWorkflow(a.workflow);
    stepsHeadEl.hidden = stepsEl.hidden = a.workflow !== undefined && a.stepCount === 0;
    // Index absolu de steps[i] = stepCount - steps.length + i : robuste à l'éviction au plafond.
    const base = a.stepCount - a.steps.length;
    for (let i = Math.max(0, renderedCount - base); i < a.steps.length; i++) stepsEl.appendChild(renderStep(a.steps[i]));
    renderedCount = Math.max(renderedCount, a.stepCount);
    while (stepsEl.childElementCount > MAX_STEPS) stepsEl.firstElementChild?.remove();
    if (a.report !== renderedReport) {
      renderedReport = a.report;
      reportEl.hidden = a.report === undefined;
      if (a.report !== undefined) renderReport(a.report);
    }
    if (atBottom) detailEl.scrollTop = detailEl.scrollHeight;
  }

  function makeRow(taskId: string): HTMLButtonElement {
    const row = el("button", "den-agents-row");
    row.type = "button";
    row.append(el("span", "den-agents-row__dot"), el("span", "den-agents-row__line"));
    row.addEventListener("click", () => {
      selectedId = taskId;
      if (agents) sync(agents);
    });
    return row;
  }

  function sync(list: Subagents): void {
    if (!list.some((a) => a.taskId === selectedId)) selectedId = list[0]?.taskId ?? null;
    const seen = new Set<string>();
    const order: HTMLElement[] = [];
    for (const a of list) {
      seen.add(a.taskId);
      let row = rows.get(a.taskId);
      if (!row) {
        row = makeRow(a.taskId);
        rows.set(a.taskId, row);
      }
      row.dataset.status = a.status;
      row.style.paddingLeft = `${10 + Math.max(0, a.depth - 1) * 16}px`;
      setText(row.querySelector(".den-agents-row__line") as HTMLElement, rowText(a));
      const current = a.taskId === selectedId;
      row.classList.toggle("den-agents-row--selected", current);
      if (current) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
      order.push(row);
    }
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.remove();
      rows.delete(id);
    }
    // appendChild déplace un nœud déjà présent : l'ordre suit `agents` sans recréer les lignes.
    order.forEach((n, i) => {
      if (listEl.children[i] !== n) listEl.appendChild(n);
    });

    const selected = list.find((a) => a.taskId === selectedId);
    if (selected) updateDetail(selected);
    else {
      shownId = null;
      detailEl.replaceChildren(el("p", "den-agents-empty", "No agents in this session"));
    }
  }

  function setAgents(list: Subagents): void {
    // Appelé à chaque chunk de streaming : même référence = rien à faire.
    if (list === agents) return;
    agents = list;
    const running = list.filter((a) => a.status === "running").length;
    setText(badgeEl, String(running));
    badgeEl.hidden = running === 0;
    sync(list);
  }

  function open(): void {
    if (opened) return;
    opened = true;
    previousFocus = document.activeElement as HTMLElement | null;
    backdrop.hidden = false;
    // Sans ligne à focuser, le focus reste dans le dialog : Escape ne doit pas atteindre le textarea (interrupt).
    (listEl.querySelector<HTMLElement>("button[aria-current]") ?? listEl.querySelector<HTMLElement>("button") ?? dialog).focus();
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    backdrop.hidden = true;
    previousFocus?.focus?.();
    previousFocus = null;
  }

  triggerEl.addEventListener("click", () => (opened ? close() : open()));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", (e) => {
    if (!opened) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      // Piège le focus : sorti du dialog, Escape atteindrait le textarea et interromprait le tour.
      const items = [...dialog.querySelectorAll<HTMLElement>("button, summary")];
      const first = items[0] ?? dialog;
      const last = items[items.length - 1] ?? dialog;
      const active = document.activeElement;
      if (!dialog.contains(active) || (e.shiftKey && (active === first || active === dialog)) || (!e.shiftKey && active === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const buttons = [...listEl.querySelectorAll<HTMLElement>("button")];
    const cur = buttons.indexOf(document.activeElement as HTMLElement);
    if (buttons.length === 0 || cur === -1) return;
    e.preventDefault();
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else if (e.key === "ArrowDown") next = (cur + 1) % buttons.length;
    else next = cur === 0 ? buttons.length - 1 : cur - 1;
    // Le focus suit la sélection : le détail affiche la ligne focalisée.
    buttons[next].click();
    buttons[next].focus();
  });

  setAgents([]);
  return { triggerEl, setAgents, open, close, isOpen: () => opened };
}
