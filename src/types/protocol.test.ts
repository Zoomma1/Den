import { describe, expect, it } from "vitest";
import {
  type ConversationMessage,
  type DenProtocolMessage,
  isAssistantDelta,
  isDone,
  isErrorMessage,
  isInterruptMessage,
  isPermissionRequest,
  isPermissionResponse,
  isQuestionRequest,
  isQuestionResponse,
  isSessionInfo,
  isSidecarToUIMessage,
  isToolResult,
  isUserEcho,
  isToolUse,
  isUIToSidecarMessage,
  isUserMessage,
} from "./protocol";

const samples: DenProtocolMessage[] = [
  { type: "user_message", id: "1", text: "salut" },
  { type: "permission_response", requestId: "r1", approved: true },
  { type: "question_response", requestId: "r2", answer: "oui" },
  { type: "interrupt" },
  { type: "assistant_delta", id: "1", text: "bon" },
  { type: "tool_use", id: "t1", name: "Read", input: {} },
  { type: "tool_result", id: "t1", toolUseId: "t1", output: "ok" },
  { type: "permission_request", requestId: "r1", toolName: "Read", input: {} },
  { type: "question_request", requestId: "r2", question: "?" },
  { type: "session_info", sessionId: "s1", model: "sonnet", apiKeySource: "none" },
  { type: "done" },
  { type: "error", message: "boom" },
];

const guards: Record<
  DenProtocolMessage["type"],
  (msg: DenProtocolMessage) => boolean
> = {
  user_message: isUserMessage,
  permission_response: isPermissionResponse,
  question_response: isQuestionResponse,
  interrupt: isInterruptMessage,
  assistant_delta: isAssistantDelta,
  tool_use: isToolUse,
  tool_result: isToolResult,
  permission_request: isPermissionRequest,
  question_request: isQuestionRequest,
  session_info: isSessionInfo,
  done: isDone,
  error: isErrorMessage,
};

describe("protocol type guards", () => {
  it.each(samples)("le guard de $type le reconnaît, aucun autre ne le reconnaît", (msg) => {
    for (const [type, guard] of Object.entries(guards)) {
      if (type === msg.type) {
        expect(guard(msg)).toBe(true);
      } else {
        expect(guard(msg)).toBe(false);
      }
    }
  });

  it("user_echo est un écho local UI, hors wire : reconnu par isUserEcho, par aucun guard wire", () => {
    const echo: ConversationMessage = {
      type: "user_echo",
      id: "u1",
      text: "mon prompt",
    };
    expect(isUserEcho(echo)).toBe(true);
    for (const guard of Object.values(guards)) {
      expect(guard(echo as unknown as DenProtocolMessage)).toBe(false);
    }
  });

  it("distingue le sens UI->sidecar du sens sidecar->UI", () => {
    const uiToSidecarTypes = new Set([
      "user_message",
      "permission_response",
      "question_response",
      "interrupt",
    ]);

    for (const msg of samples) {
      if (uiToSidecarTypes.has(msg.type)) {
        expect(isUIToSidecarMessage(msg)).toBe(true);
        expect(isSidecarToUIMessage(msg)).toBe(false);
      } else {
        expect(isUIToSidecarMessage(msg)).toBe(false);
        expect(isSidecarToUIMessage(msg)).toBe(true);
      }
    }
  });
});
