// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderPermissionBlock, renderQuestionBlock } from "./blocks";
import type { PermissionRequest, QuestionRequest } from "../types/protocol";

function content(): HTMLElement {
  return document.createElement("div");
}

describe("renderPermissionBlock", () => {
  const message: PermissionRequest = {
    type: "permission_request",
    requestId: "req-1",
    toolName: "Bash",
    input: { command: "rm -rf /tmp/x" },
  };

  it("affiche le nom de l'outil et l'input, avec deux boutons de décision", () => {
    const el = content();
    renderPermissionBlock(el, message, () => {});

    expect(el.textContent).toContain("Bash");
    expect(el.querySelector(".den-decision-block__detail")?.textContent).toContain(
      "rm -rf /tmp/x",
    );
    expect(el.querySelector(".den-btn--allow")).not.toBeNull();
    expect(el.querySelector(".den-btn--deny")).not.toBeNull();
  });

  it("clic sur Autoriser envoie approved:true et désactive les boutons", () => {
    const el = content();
    const responses: unknown[] = [];
    renderPermissionBlock(el, message, (response) => responses.push(response));

    const allowBtn = el.querySelector<HTMLButtonElement>(".den-btn--allow")!;
    const denyBtn = el.querySelector<HTMLButtonElement>(".den-btn--deny")!;
    allowBtn.click();

    expect(responses).toEqual([
      { type: "permission_response", requestId: "req-1", approved: true },
    ]);
    expect(allowBtn.disabled).toBe(true);
    expect(denyBtn.disabled).toBe(true);
    expect(el.querySelector(".den-decision-block__status")?.textContent).toContain("Autorisé");
  });

  it("clic sur Refuser envoie approved:false", () => {
    const el = content();
    const responses: unknown[] = [];
    renderPermissionBlock(el, message, (response) => responses.push(response));

    el.querySelector<HTMLButtonElement>(".den-btn--deny")!.click();

    expect(responses).toEqual([
      { type: "permission_response", requestId: "req-1", approved: false },
    ]);
  });

  it("un second clic après décision n'envoie pas de deuxième réponse", () => {
    const el = content();
    const responses: unknown[] = [];
    renderPermissionBlock(el, message, (response) => responses.push(response));

    const allowBtn = el.querySelector<HTMLButtonElement>(".den-btn--allow")!;
    allowBtn.click();
    // Bouton désactivé : un second .click() programmatique appelle quand
    // même le handler JS (jsdom/happy-dom n'empêchent pas .click() sur un
    // bouton disabled) — le flag `settled` interne doit être le vrai garde-fou.
    allowBtn.click();
    el.querySelector<HTMLButtonElement>(".den-btn--deny")!.click();

    expect(responses).toHaveLength(1);
  });
});

describe("renderQuestionBlock", () => {
  const message: QuestionRequest = {
    type: "question_request",
    requestId: "req-2",
    question: "Quelle approche préfères-tu ?",
    options: ["Option A", "Option B"],
  };

  it("affiche la question et une option cliquable par choix", () => {
    const el = content();
    renderQuestionBlock(el, message, () => {});

    expect(el.textContent).toContain("Quelle approche préfères-tu ?");
    const options = el.querySelectorAll(".den-btn--option");
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe("Option A");
    expect(options[1].textContent).toBe("Option B");
  });

  it("toujours un champ libre disponible, même avec des options", () => {
    const el = content();
    renderQuestionBlock(el, message, () => {});
    expect(el.querySelector(".den-decision-block__input")).not.toBeNull();
  });

  it("clic sur une option envoie son libellé comme réponse et verrouille tout", () => {
    const el = content();
    const responses: unknown[] = [];
    renderQuestionBlock(el, message, (response) => responses.push(response));

    el.querySelectorAll<HTMLButtonElement>(".den-btn--option")[1].click();

    expect(responses).toEqual([
      { type: "question_response", requestId: "req-2", answer: "Option B" },
    ]);
    for (const btn of el.querySelectorAll<HTMLButtonElement>(".den-btn--option")) {
      expect(btn.disabled).toBe(true);
    }
    expect(el.querySelector<HTMLInputElement>(".den-decision-block__input")!.disabled).toBe(
      true,
    );
  });

  it("soumettre le champ libre envoie le texte saisi (trim)", () => {
    const el = content();
    const responses: unknown[] = [];
    renderQuestionBlock(el, message, (response) => responses.push(response));

    const input = el.querySelector<HTMLInputElement>(".den-decision-block__input")!;
    input.value = "  Autre chose  ";
    el.querySelector("form")!.requestSubmit();

    expect(responses).toEqual([
      { type: "question_response", requestId: "req-2", answer: "Autre chose" },
    ]);
  });

  it("une soumission vide n'envoie rien", () => {
    const el = content();
    const responses: unknown[] = [];
    renderQuestionBlock(el, message, (response) => responses.push(response));

    const input = el.querySelector<HTMLInputElement>(".den-decision-block__input")!;
    input.value = "   ";
    el.querySelector("form")!.requestSubmit();

    expect(responses).toHaveLength(0);
  });

  it("sans options fournies, seul le champ libre est rendu", () => {
    const el = content();
    renderQuestionBlock(
      el,
      { type: "question_request", requestId: "req-3", question: "Continuer ?" },
      () => {},
    );

    expect(el.querySelectorAll(".den-btn--option")).toHaveLength(0);
    expect(el.querySelector(".den-decision-block__input")).not.toBeNull();
  });
});
