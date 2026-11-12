"use client";

import { useSyncExternalStore } from "react";
import { subscribeTranslateStatus, translateStatusSnapshot, type TranslateStatus } from "@/lib/translate-client";

const serverSnapshot = () => null;

/** Server translation settings; null until loaded. */
export function useTranslateStatus(): TranslateStatus | null {
  return useSyncExternalStore(subscribeTranslateStatus, translateStatusSnapshot, serverSnapshot);
}

/** Translate buttons render only when an API is configured. */
export function useTranslateAvailable(): boolean {
  return useTranslateStatus()?.configured === true;
}
