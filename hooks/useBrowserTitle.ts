"use client";

import { useEffect, useState } from "react";
import { maintainBrowserTitle, subscribeBrowserActivity } from "@/lib/browser-title";

export function useBrowserTitle(title: string): void {
  const [running, setRunning] = useState(false);
  useEffect(() => subscribeBrowserActivity(setRunning), []);
  useEffect(() => maintainBrowserTitle(title, running), [title, running]);
}
