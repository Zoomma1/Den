export interface CommandEntry {
  name: string;
  description: string;
}

const norm = (n: string): string => n.replace(/^\/+/, "").trim().toLowerCase();

// Skills du SDK d'abord (ordre SDK), puis built-ins sans description par ordre alphabétique.
export function mergeCommands(
  supported: readonly CommandEntry[],
  initNames: readonly string[],
  terminalOnly: readonly string[],
): CommandEntry[] {
  const hidden = new Set(terminalOnly.map(norm));
  const seen = new Set<string>();
  const skills: CommandEntry[] = [];
  const builtIns: CommandEntry[] = [];

  for (const c of supported) {
    const key = norm(c.name);
    if (!key || hidden.has(key) || seen.has(key)) continue;
    seen.add(key);
    skills.push({ name: c.name, description: c.description });
  }
  for (const raw of initNames) {
    const key = norm(raw);
    if (!key || hidden.has(key) || seen.has(key)) continue;
    seen.add(key);
    builtIns.push({ name: raw.trim().replace(/^\/+/, ""), description: "" });
  }
  builtIns.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return [...skills, ...builtIns];
}
