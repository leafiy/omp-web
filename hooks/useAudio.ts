"use client";

import { useState, useRef, useCallback, useEffect } from "react";

function playTone(ctx: AudioContext) {
  const now = ctx.currentTime;
  const freqs = [523.25, 659.25];
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.start(t);
    osc.stop(t + 0.45);
  });
}

// One AudioContext for every hook instance, so it can be resumed if the
// browser autoplay policy suspends it (contexts created outside user gestures
// start in "suspended" state and produce no sound). Sharing it lets a gesture
// that unlocks audio in the chat also cover the sidebar's background chimes.
let sharedCtx: AudioContext | null = null;
const SOUND_TOGGLE_EVENT = "omp-web:sound-toggle";

export function useAudio() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("pi-sound-enabled");
    return stored === null ? true : stored === "true";
  });

  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Keep every instance in step with the user's sound toggle.
  useEffect(() => {
    const onToggle = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail === true;
      enabledRef.current = next;
      setEnabled(next);
    };
    window.addEventListener(SOUND_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(SOUND_TOGGLE_EVENT, onToggle);
  }, []);

  const getCtx = useCallback((): AudioContext | null => {
    if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
    try {
      sharedCtx = new AudioContext();
    } catch {
      return null;
    }
    return sharedCtx;
  }, []);

  const unlockAudio = useCallback((force = false) => {
    if (!force && !enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx || ctx.state !== "suspended") return;
    ctx.resume().catch(() => {});
  }, [getCtx]);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    if (next) unlockAudio(true);
    enabledRef.current = next;
    localStorage.setItem("pi-sound-enabled", String(next));
    setEnabled(next);
    window.dispatchEvent(new CustomEvent(SOUND_TOGGLE_EVENT, { detail: next }));
  }, [unlockAudio]);

  const playDone = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;
    const play = () => {
      try {
        playTone(ctx);
      } catch {
        // AudioContext not available
      }
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(play).catch(() => {});
      return;
    }
    play();
  }, [getCtx]);

  return { soundEnabled: enabled, onSoundToggle: toggle, playDoneSound: playDone, unlockAudio, soundEnabledRef: enabledRef };
}
