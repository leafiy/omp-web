"use client";

import { useSyncExternalStore } from "react";
import {
  getServerTodoJump,
  getServerTodoState,
  getTodoJumpNotice,
  getTodoJumpRequest,
  getTodoState,
  subscribeTodoJump,
  subscribeTodos,
} from "@/lib/todo-client";

/** Shared server todo list; the first subscriber starts visible-tab polling. */
export function useTodos() {
  return useSyncExternalStore(subscribeTodos, getTodoState, getServerTodoState);
}

export function useTodoJumpRequest() {
  return useSyncExternalStore(subscribeTodoJump, getTodoJumpRequest, getServerTodoJump);
}

export function useTodoJumpNotice() {
  return useSyncExternalStore(subscribeTodoJump, getTodoJumpNotice, getServerTodoJump);
}
