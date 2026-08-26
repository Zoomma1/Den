/**
 * Rendu Markdown incrémental — logique pure, sans DOM.
 *
 * Stratégie de streaming (contrainte de résultat CLAUDE.md racine : replay
 * d'un transcript réel à vitesse réelle sans freeze perceptible) :
 *
 *   « append des blocs markdown terminés + re-render du seul bloc en cours »
 *
 * On ne relance JAMAIS `marked.lexer()` sur le texte entier du message
 * accumulé — seulement sur la queue de texte non encore finalisée (`pending`,
 * borné à la taille du bloc markdown en cours de streaming, pas à la taille
 * du message entier).
 *
 * Point de coupure sûr : une ligne vide ("\n\n", tokenisée par `marked` en
 * token `space`) est le seul signal qu'on traite comme une frontière de bloc
 * définitive. Tout ce qui précède le dernier token `space` est finalisé une
 * fois pour toutes ; tout ce qui suit reste la queue courante, re-rendue à
 * chaque delta. On a d'abord essayé « tous les tokens sauf le dernier sont
 * stables » (plus agressif), mais ça casse sur les listes : un item de liste
 * vide en fin de chunk (`"- \n"`) peut se retrouver, une fois le contenu de
 * l'item suivant arrivé, requalifié en paragraphe séparé au lieu de rester
 * dans la liste — une coupure prise sur ce token aurait figé une structure
 * fausse de façon irréversible. Couper uniquement sur une ligne vide confirmée
 * évite cette classe de bug : à l'intérieur d'un fence de code non fermé, une
 * ligne vide interne ne génère pas de token `space` (elle fait partie du
 * texte du token `code`), donc ce point de coupure ne fragmente jamais un
 * bloc encore ouvert.
 *
 * Limite connue et acceptée : dans le cas pathologique d'un unique bloc
 * sans ligne vide qui ne se referme jamais avant `finalize()` (ex. un très
 * long paragraphe, ou une liste qui n'est jamais suivie d'une ligne vide
 * avant la fin du message), le coût de `feed()` redevient proportionnel à
 * la taille de ce bloc — borne inhérente au fait qu'on ne peut pas savoir
 * qu'un bloc markdown est terminé avant qu'une ligne vide (ou la fin du
 * message) ne le confirme.
 */
import { Marked, type Token } from "marked";
import hljs from "highlight.js";

export interface FeedResult {
  /** HTML des blocs nouvellement finalisés depuis le dernier appel (0 à N, dans l'ordre). */
  finalizedHtml: string[];
  /** HTML du bloc en cours de streaming (remplace entièrement le rendu précédent du bloc courant). */
  currentHtml: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightCode(text: string, lang: string | undefined): string {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  let highlighted: string;
  try {
    highlighted = language
      ? hljs.highlight(text, { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(text).value;
  } catch {
    highlighted = escapeHtml(text);
  }
  const langClass = language ? ` language-${language}` : "";
  return `<pre class="den-code"><code class="hljs${langClass}">${highlighted}</code></pre>`;
}

/**
 * Instance `marked` partagée, configurée pour la coloration syntaxique des
 * blocs de code.
 *
 * Sécurité : le texte streamé (assistant, mais aussi contenu de fichiers ou
 * de pages web rapporté par un tool_result puis potentiellement reformulé
 * par l'assistant) est non fiable — injection de prompt possible via un
 * fichier ou une page malveillante. `marked` laisse par défaut passer le
 * HTML brut détecté dans le Markdown (`renderer.html` retourne le texte tel
 * quel). On l'échappe explicitement ici : le rendu final passe par
 * `innerHTML` (cf. `conversationView.ts`), un HTML brut non échappé y
 * serait exécuté tel quel (XSS). Le Markdown "normal" (gras, liens, code,
 * listes, tableaux...) ne passe pas par ce chemin et n'est pas affecté.
 */
export function createMarkdownEngine(): Marked {
  const md = new Marked();
  md.use({
    gfm: true,
    breaks: true,
    renderer: {
      code({ text, lang }) {
        return highlightCode(text, lang);
      },
      html({ text }) {
        return escapeHtml(text);
      },
    },
  });
  return md;
}

export class IncrementalMarkdownRenderer {
  private readonly md: Marked;
  private pending = "";

  constructor(md: Marked = createMarkdownEngine()) {
    this.md = md;
  }

  /** Texte non encore finalisé (bloc markdown en cours) — utile pour les tests. */
  get pendingText(): string {
    return this.pending;
  }

  /**
   * Consomme un nouveau fragment de texte streamé. Ne relit jamais que la
   * queue non finalisée : ne PAS appeler avec le texte du message entier.
   */
  feed(deltaText: string): FeedResult {
    this.pending += deltaText;
    if (this.pending.length === 0) {
      return { finalizedHtml: [], currentHtml: "" };
    }

    let tokens: Token[];
    try {
      tokens = this.md.lexer(this.pending);
    } catch {
      // Texte pas encore parsable isolément (rarissime) : on l'affiche tel
      // quel en attendant plus de contexte, sans rien finaliser.
      return { finalizedHtml: [], currentHtml: escapeHtml(this.pending) };
    }

    if (tokens.length === 0) {
      return { finalizedHtml: [], currentHtml: "" };
    }

    // Dernier token `space` (ligne vide) rencontré : seule frontière de bloc
    // qu'on traite comme définitive (cf. commentaire d'en-tête du fichier).
    let lastSpaceIndex = -1;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].type === "space") {
        lastSpaceIndex = i;
      }
    }

    if (lastSpaceIndex === -1) {
      // Aucune ligne vide confirmée pour l'instant : tout reste "courant".
      return { finalizedHtml: [], currentHtml: this.md.parser(tokens) };
    }

    const finalizedTokens = tokens.slice(0, lastSpaceIndex + 1);
    const remainingTokens = tokens.slice(lastSpaceIndex + 1);
    const finalizedRawLength = finalizedTokens.reduce(
      (sum, t) => sum + t.raw.length,
      0,
    );

    const finalizedHtml = [this.md.parser(finalizedTokens)];
    // La queue non finalisée redevient uniquement ce qui suit la dernière
    // ligne vide confirmée — jamais le buffer entier du message.
    this.pending = this.pending.slice(finalizedRawLength);
    const currentHtml =
      remainingTokens.length > 0 ? this.md.parser(remainingTokens) : "";
    return { finalizedHtml, currentHtml };
  }

  /**
   * Force la finalisation du texte restant en queue (ex: message `done` ou
   * changement d'id d'un nouveau message assistant). Idempotent si la queue
   * est vide.
   */
  finalize(): string[] {
    if (this.pending.length === 0) {
      return [];
    }
    const tokens = this.md.lexer(this.pending);
    this.pending = "";
    if (tokens.length === 0) {
      return [];
    }
    return [this.md.parser(tokens)];
  }
}
