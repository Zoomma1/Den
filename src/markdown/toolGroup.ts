/** Signatures figées pour le lot de repli ToolGroup (DEN-32 phase 3). */

/** Appel d'outil tel que groupé par le moteur (ToolGroupCall réduit au nécessaire). */
export interface ToolGroupCall {
  tool: string;
  input: unknown;
  isErrored?: boolean;
  isRunning?: boolean;
}

const READ_ONLY = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"]);
const MCP_READ_VERBS = new Set(["get", "list", "read", "search", "find", "fetch", "describe", "query"]);
// Un seul mot de mutation dans le nom suffit à refuser le repli (get_or_create_user, query_and_delete).
const MCP_MUTATING = new Set([
  "create", "update", "delete", "remove", "set", "write", "send", "post", "put", "patch", "move",
  "add", "edit", "insert", "drop", "run", "exec", "execute", "upload", "save", "reset", "clear", "or", "and",
]);

/** Vrai si l'outil ne modifie rien (lecture, recherche, listing) et peut se replier dans un groupe. */
export function isReadOnlyTool(name: string): boolean {
  if (READ_ONLY.has(name)) return true;
  if (!name.startsWith("mcp__")) return false;
  const [, server = "", ...rest] = name.split("__");
  const tokens = rest.join("__").toLowerCase().split(/[-_]+/).filter(Boolean);
  // Le verbe est le premier mot, ou le second quand le premier répète le nom du serveur (notion-get-users).
  const verbAt = tokens[0] === server.toLowerCase() ? 1 : 0;
  return MCP_READ_VERBS.has(tokens[verbAt] ?? "") && !tokens.some((t) => MCP_MUTATING.has(t));
}

// mcp__serveur__outil -> outil : le nom interne n'a pas sa place dans un résumé lu par l'utilisateur.
const shortName = (tool: string) => (tool.startsWith("mcp__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function family(tool: string): { key: string; render: (n: number) => string } {
  switch (tool) {
    case "Read":
      return { key: "Read", render: (n) => `Read ${plural(n, "file", "files")}` };
    case "Grep":
    case "Glob":
      return { key: "search", render: (n) => `searched ${plural(n, "pattern", "patterns")}` };
    case "LS":
      return { key: "LS", render: (n) => `listed ${plural(n, "directory", "directories")}` };
    default: {
      const label = shortName(tool);
      return { key: `tool:${tool}`, render: (n) => `ran ${plural(n, `${label} call`, `${label} calls`)}` };
    }
  }
}

/** Résumé d'une suite d'appels repliés, ex. « Read 3 files, searched 1 pattern ». */
export function summarizeToolRun(calls: readonly ToolGroupCall[]): string {
  const groups = new Map<string, { count: number; render: (n: number) => string }>();
  for (const { tool } of calls) {
    const f = family(tool);
    const g = groups.get(f.key);
    if (g) g.count++;
    else groups.set(f.key, { count: 1, render: f.render });
  }
  const text = [...groups.values()].map((g) => g.render(g.count)).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
