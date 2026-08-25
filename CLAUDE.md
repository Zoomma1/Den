# CLAUDE.md — Den

## Commandes

| Commande | Dossier | Action |
|----------|---------|--------|
| `npm run tauri dev` | racine | Lancer l'app en dev `[créée au lot 0 — à confirmer]` |
| `npx vitest run` | racine | Tests TS `[créée au lot 0 — à confirmer]` |
| `cargo check` | `src-tauri/` | Vérification Rust `[créée au lot 0 — à confirmer]` |

## Architecture

- **Tauri v2** — Rust (`src-tauri/`) limité à : spawn/lifecycle des sidecars, PTY, IPC. Toute la logique protocole/UI vit côté TS.
- **Sidecar Node + Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — **un sidecar par session/tab**, un crash n'emporte qu'un tab.
- **Flux terminal** : `portable-pty` (Rust) → `Channel<T>` Tauri → xterm.js.

## Règles obligatoires

- **Jamais `tauri-plugin-shell` pour le terminal** — il n'alloue pas de PTY (vim/couleurs/SIGWINCH cassés). `portable-pty` uniquement.
- **Jamais `ANTHROPIC_API_KEY` dans l'environnement de l'app** — l'auth passe par l'OAuth abonnement du CLI loggé (`apiKeySource: none`). Une clé API en env **primerait** et basculerait en facturation API (spike 2026-08-24).
- **Jamais `emit()` Tauri pour le flux PTY** — haut débit → `Channel<T>` exclusivement.
- **Rendu markdown** : contrainte de résultat — replay d'un transcript réel à vitesse réelle sans freeze perceptible. Stratégie libre, résultat non négociable.
- **Plugin system** : point d'entrée minimal (ADR-002) — pas d'écosystème au MVP.
- Les features s'implémentent via `/implement-feature` (partition en lots validée par Victor — jamais de fleet non validé). Contrat : ticket DEN-01 dans le vault.
