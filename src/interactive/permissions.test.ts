/**
 * Corrélation requête/réponse de `PermissionBroker` (logique pure, cf.
 * sidecar/src/permissions.ts). Le module vit dans `sidecar/src` (câblage
 * `canUseTool` du SDK) mais ce test est placé ici pour être ramassé par la
 * config vitest racine (`include: ["src/**\/*.test.ts"]`, hors périmètre de
 * ce lot) — import relatif vers le module réel, aucune duplication.
 */
import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../../sidecar/src/permissions";
import type { SidecarToUIMessage } from "../types/protocol";

/**
 * Type des `suggestions` de `CanUseTool`, dérivé structurellement de
 * `PermissionBroker.canUseTool` plutôt qu'importé directement du SDK :
 * `@anthropic-ai/claude-agent-sdk` n'est déclaré que dans
 * `sidecar/package.json` (résolution "bundler" ancrée au fichier important,
 * cf. `sidecar/src/permissions.ts`) et ce fichier de test vit sous `src/`.
 */
type CanUseToolOptions = Parameters<PermissionBroker["canUseTool"]>[2];
type PermissionUpdate = NonNullable<CanUseToolOptions["suggestions"]>[number];

function canUseToolOptions(
  overrides: Partial<{
    requestId: string;
    signal: AbortSignal;
    suggestions: PermissionUpdate[];
  }> = {},
) {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    toolUseID: "tool-use-1",
    requestId: overrides.requestId ?? "req-1",
    suggestions: overrides.suggestions,
  };
}

describe("PermissionBroker", () => {
  it("émet un permission_request et résout allow quand la réponse approuve", async () => {
    const sent: SidecarToUIMessage[] = [];
    const broker = new PermissionBroker((msg) => sent.push(msg));

    const pending = broker.canUseTool("Bash", { command: "ls" }, canUseToolOptions());

    expect(sent).toEqual([
      {
        type: "permission_request",
        requestId: "req-1",
        toolName: "Bash",
        input: { command: "ls" },
      },
    ]);
    expect(broker.pendingCount).toBe(1);

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-1",
      approved: true,
    });

    const result = await pending;
    expect(result).toEqual({ behavior: "allow" });
    expect(broker.pendingCount).toBe(0);
  });

  it("résout deny avec le message de raison quand la réponse refuse", async () => {
    const broker = new PermissionBroker(() => {});
    const pending = broker.canUseTool("Bash", { command: "rm -rf /" }, canUseToolOptions());

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-1",
      approved: false,
      reason: "trop dangereux",
    });

    const result = await pending;
    expect(result).toEqual({ behavior: "deny", message: "trop dangereux" });
  });

  it("utilise un message de refus par défaut quand aucune raison n'est fournie", async () => {
    const broker = new PermissionBroker(() => {});
    const pending = broker.canUseTool("Bash", {}, canUseToolOptions());

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-1",
      approved: false,
    });

    const result = await pending;
    expect(result).toEqual({ behavior: "deny", message: "Refusé par l'utilisateur." });
  });

  it("route AskUserQuestion vers un question_request dérivé de la première question", async () => {
    const sent: SidecarToUIMessage[] = [];
    const broker = new PermissionBroker((msg) => sent.push(msg));

    const input = {
      questions: [
        {
          question: "Quelle librairie de dates ?",
          header: "Librairie",
          options: [
            { label: "date-fns", description: "légère" },
            { label: "dayjs", description: "compatible moment" },
          ],
          multiSelect: false,
        },
      ],
    };

    const pending = broker.canUseTool("AskUserQuestion", input, canUseToolOptions());

    expect(sent).toEqual([
      {
        type: "question_request",
        requestId: "req-1",
        question: "Quelle librairie de dates ?",
        options: ["date-fns", "dayjs"],
      },
    ]);

    broker.handleQuestionResponse({
      type: "question_response",
      requestId: "req-1",
      answer: "date-fns",
    });

    const result = await pending;
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "Quelle librairie de dates ?": "date-fns" },
      },
    });
  });

  it("dégrade proprement une AskUserQuestion sans structure exploitable", async () => {
    const sent: SidecarToUIMessage[] = [];
    const broker = new PermissionBroker((msg) => sent.push(msg));

    broker.canUseTool("AskUserQuestion", {}, canUseToolOptions());

    expect(sent).toEqual([
      {
        type: "question_request",
        requestId: "req-1",
        question: "AskUserQuestion : question sans texte exploitable.",
        options: undefined,
      },
    ]);
  });

  it("ignore une réponse dont le requestId ne correspond à aucune requête en attente", async () => {
    const broker = new PermissionBroker(() => {});
    const pending = broker.canUseTool("Bash", {}, canUseToolOptions({ requestId: "req-1" }));

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-inconnu",
      approved: true,
    });

    expect(broker.pendingCount).toBe(1);

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-1",
      approved: true,
    });
    await expect(pending).resolves.toEqual({ behavior: "allow" });
  });

  it("ignore une question_response adressée à une requête de type permission (et vice versa)", async () => {
    const broker = new PermissionBroker(() => {});
    const permissionPending = broker.canUseTool(
      "Bash",
      {},
      canUseToolOptions({ requestId: "req-perm" }),
    );

    // Une question_response sur le même requestId qu'une permission en
    // attente ne doit rien résoudre (mauvais type de réponse).
    broker.handleQuestionResponse({
      type: "question_response",
      requestId: "req-perm",
      answer: "peu importe",
    });
    expect(broker.pendingCount).toBe(1);

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-perm",
      approved: true,
    });
    await expect(permissionPending).resolves.toEqual({ behavior: "allow" });
  });

  it("résout deny immédiatement si le signal est déjà aborted à l'appel", async () => {
    const controller = new AbortController();
    controller.abort();
    const broker = new PermissionBroker(() => {});

    const result = await broker.canUseTool(
      "Bash",
      {},
      canUseToolOptions({ signal: controller.signal }),
    );

    expect(result).toEqual({
      behavior: "deny",
      message: "Requête annulée : session interrompue.",
      interrupt: true,
    });
    expect(broker.pendingCount).toBe(0);
  });

  it("résout deny quand le signal s'abort après coup, sans réponse jamais reçue", async () => {
    const controller = new AbortController();
    const broker = new PermissionBroker(() => {});

    const pending = broker.canUseTool(
      "Bash",
      {},
      canUseToolOptions({ signal: controller.signal }),
    );
    expect(broker.pendingCount).toBe(1);

    controller.abort();

    const result = await pending;
    expect(result).toEqual({
      behavior: "deny",
      message: "Requête annulée : session interrompue.",
      interrupt: true,
    });
    expect(broker.pendingCount).toBe(0);
  });

  it("transmet suggestions/title/displayName/description dans le permission_request émis", async () => {
    const sent: SidecarToUIMessage[] = [];
    const broker = new PermissionBroker((msg) => sent.push(msg));

    const suggestions: PermissionUpdate[] = [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" },
    ];

    broker.canUseTool("Bash", { command: "ls" }, {
      ...canUseToolOptions({ suggestions }),
      title: "Claude veut exécuter ls",
      displayName: "Exécuter une commande",
      description: "Claude aura accès à ls dans ce répertoire.",
    });

    expect(sent).toEqual([
      {
        type: "permission_request",
        requestId: "req-1",
        toolName: "Bash",
        input: { command: "ls" },
        suggestions,
        title: "Claude veut exécuter ls",
        displayName: "Exécuter une commande",
        description: "Claude aura accès à ls dans ce répertoire.",
      },
    ]);
  });

  it("omet suggestions/title/displayName/description du permission_request quand non fournis", async () => {
    const sent: SidecarToUIMessage[] = [];
    const broker = new PermissionBroker((msg) => sent.push(msg));

    broker.canUseTool("Bash", { command: "ls" }, canUseToolOptions());

    // `toEqual` ignore les propriétés à valeur undefined des deux côtés (cf.
    // les tests existants du fichier) : ce couple d'assertions vérifie à la
    // fois l'absence côté objet et, au sens strict du protocole, l'absence
    // de la clé dans le JSON réellement émis sur le wire (`send` de
    // main.ts fait `JSON.stringify`, qui abandonne les clés `undefined`).
    expect(sent).toEqual([
      {
        type: "permission_request",
        requestId: "req-1",
        toolName: "Bash",
        input: { command: "ls" },
      },
    ]);
    expect(JSON.stringify(sent[0])).not.toContain("suggestions");
  });

  it("approved + destination avec suggestions mixtes : seule l'entrée addRules voit sa destination réécrite", async () => {
    const broker = new PermissionBroker(() => {});
    const suggestions: PermissionUpdate[] = [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ];

    const pending = broker.canUseTool("Bash", { command: "ls" }, canUseToolOptions({ suggestions }));

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-1",
      approved: true,
      destination: "userSettings",
    });

    const result = await pending;
    expect(result).toEqual({
      behavior: "allow",
      updatedPermissions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "userSettings" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    });
  });

  it("approved + destination sans suggestions retenues -> allow nu sans updatedPermissions", async () => {
    const broker = new PermissionBroker(() => {});
    const pending = broker.canUseTool("Bash", {}, canUseToolOptions());

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-1",
      approved: true,
      destination: "userSettings",
    });

    const result = await pending;
    expect(result).toEqual({ behavior: "allow" });
    expect(result).not.toHaveProperty("updatedPermissions");
  });

  it("approved sans destination avec suggestions -> allow nu sans updatedPermissions", async () => {
    const broker = new PermissionBroker(() => {});
    const suggestions: PermissionUpdate[] = [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" },
    ];
    const pending = broker.canUseTool("Bash", {}, canUseToolOptions({ suggestions }));

    broker.handlePermissionResponse({
      type: "permission_response",
      requestId: "req-1",
      approved: true,
    });

    const result = await pending;
    expect(result).toEqual({ behavior: "allow" });
    expect(result).not.toHaveProperty("updatedPermissions");
  });

  it("rejectAllPending résout en deny toutes les requêtes encore en attente", async () => {
    const broker = new PermissionBroker(() => {});
    const p1 = broker.canUseTool("Bash", {}, canUseToolOptions({ requestId: "req-1" }));
    const p2 = broker.canUseTool("Read", {}, canUseToolOptions({ requestId: "req-2" }));
    expect(broker.pendingCount).toBe(2);

    broker.rejectAllPending("Session close.");

    await expect(p1).resolves.toEqual({
      behavior: "deny",
      message: "Session close.",
      interrupt: true,
    });
    await expect(p2).resolves.toEqual({
      behavior: "deny",
      message: "Session close.",
      interrupt: true,
    });
    expect(broker.pendingCount).toBe(0);
  });
});
