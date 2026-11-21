"use client";

import { useEffect, useRef, type RefObject } from "react";
import { historyTurnKey, type HistoryTurnSummary } from "@/lib/history-turns";
import { finishTodoJump } from "@/lib/todo-client";
import type { HistoryTurnState } from "./useAgentSession";
import { useTodoJumpRequest } from "./useTodos";

export const TODO_JUMP_HIGHLIGHT_CLASS = "todo-jump-highlight";

function cssString(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/**
 * Rendered messages carry `data-entry-id`; a folded process group lists its
 * hidden messages in `data-process-entries`. Duplicated renders of one entry
 * (process part + final answer) resolve to the first visible element.
 */
function findEntryElement(container: HTMLElement, entryId: string): HTMLElement | null {
  const id = cssString(entryId);
  for (const element of container.querySelectorAll<HTMLElement>(`[data-entry-id="${id}"]`)) {
    if (element.getClientRects().length > 0) return element;
  }
  return container.querySelector<HTMLElement>(`[data-process-entries~="${id}"]`);
}

function reveal(element: HTMLElement) {
  element.scrollIntoView({ block: "center", behavior: "auto" });
  element.classList.remove(TODO_JUMP_HIGHLIGHT_CLASS);
  void element.offsetWidth; // Restart the flash when the same message is chosen again.
  element.classList.add(TODO_JUMP_HIGHLIGHT_CLASS);
  window.setTimeout(() => element.classList.remove(TODO_JUMP_HIGHLIGHT_CLASS), 2400);
}

/**
 * Resolves a todo jump for this chat once its history is on screen: scroll to
 * the message, opening its folded history turn first when needed.
 */
export function useTodoJump({
  sessionId,
  loading,
  entryIds,
  historyTurns,
  historyTurnStates,
  toggleHistoryTurn,
  scrollContainerRef,
  beforeScroll,
}: {
  sessionId: string | undefined;
  loading: boolean;
  entryIds: string[];
  historyTurns: HistoryTurnSummary[];
  historyTurnStates: Record<string, HistoryTurnState>;
  toggleHistoryTurn: (turn: HistoryTurnSummary) => Promise<void>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Stop new-content auto-scroll from pulling the reader back to the bottom. */
  beforeScroll?: () => void;
}) {
  const request = useTodoJumpRequest();
  const openedTurnRef = useRef<string | null>(null);

  useEffect(() => {
    if (!request || !sessionId || request.sessionId !== sessionId || loading) return;
    const entryId = request.entryId;
    if (!entryId) { finishTodoJump(request.nonce); return; }
    // History has not been applied yet.
    if (entryIds.length === 0 && historyTurns.length === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const target = findEntryElement(container, entryId);
    if (target) {
      beforeScroll?.();
      reveal(target);
      finishTodoJump(request.nonce);
      return;
    }

    const turn = (request.turnId ? historyTurns.find((item) => item.id === request.turnId) : undefined)
      ?? historyTurns.find((item) => item.id === entryId || item.lastId === entryId
        || historyTurnStates[historyTurnKey(item)]?.entryIds?.includes(entryId));
    if (turn) {
      const key = historyTurnKey(turn);
      const state = historyTurnStates[key];
      if (state?.loading) return;
      const attempt = `${request.nonce}\u0000${key}`;
      // Open it once per request; a turn that failed before is retried once.
      if (!state?.expanded && openedTurnRef.current !== attempt) {
        openedTurnRef.current = attempt;
        void toggleHistoryTurn(turn);
        return;
      }
      // The turn is open (or failed to load) but the message is not drawn:
      // show the turn itself rather than nothing.
      const row = container.querySelector<HTMLElement>(`[data-history-turn="${cssString(turn.id)}"]`);
      if (row) {
        beforeScroll?.();
        reveal(row);
      }
      finishTodoJump(request.nonce, state?.expanded && row ? undefined : "messageNotFound");
      return;
    }
    finishTodoJump(request.nonce, "messageNotFound");
  }, [request, sessionId, loading, entryIds, historyTurns, historyTurnStates, toggleHistoryTurn, scrollContainerRef, beforeScroll]);
}
