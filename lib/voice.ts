'use client';

/**
 * Listening.
 *
 * A thin wrapper over the browser's speech recognition, kept deliberately
 * small: it starts, it hands back what it heard, and it restarts itself when
 * the browser stops on its own (which it does, constantly). Everything about
 * what the words MEAN lives in src/voice/parser.ts, which is pure and tested.
 *
 * This is an experiment and is off unless someone turns it on. Two honest
 * limitations to know before relying on it:
 *
 *  - It needs the network. The browser streams audio to a server, so on a
 *    ground with no signal it will not work, which is the same ground this app
 *    is otherwise built to work on.
 *  - Support is uneven, and on iPhone it may not exist at all.
 */

export type VoiceMode = 'off' | 'assist' | 'hands_free';

const MODE_KEY = 'box-cricket.voice';

export function loadVoiceMode(): VoiceMode {
  if (typeof window === 'undefined') return 'off';
  const stored = window.localStorage.getItem(MODE_KEY);
  return stored === 'assist' || stored === 'hands_free' ? stored : 'off';
}

export function saveVoiceMode(mode: VoiceMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* a preference is not worth failing over */
  }
}

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

function recognitionClass(): (new () => RecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupported(): boolean {
  return recognitionClass() !== null;
}

export interface Listener {
  stop: () => void;
}

/**
 * Listen until stopped. `onHeard` gets each final phrase; `onState` reports
 * whether the microphone is actually live, because a mic that has quietly died
 * is worse than one that was never on.
 */
export function listen(
  onHeard: (text: string) => void,
  onState?: (live: boolean, error?: string) => void,
): Listener {
  const Recognition = recognitionClass();
  if (!Recognition) {
    onState?.(false, 'This browser cannot listen');
    return { stop: () => undefined };
  }

  let stopped = false;
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = 'en-IN';

  recognition.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    const phrase = last?.[0]?.transcript ?? '';
    if (phrase.trim() !== '') onHeard(phrase);
  };

  recognition.onerror = (e) => {
    // "no-speech" and "aborted" are routine; anything else is worth surfacing.
    if (e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
      onState?.(false, e.error);
    }
  };

  // Browsers end the session on their own after a pause. Start it again, or
  // the microphone appears on and hears nothing for the rest of the over.
  recognition.onend = () => {
    if (stopped) {
      onState?.(false);
      return;
    }
    try {
      recognition.start();
    } catch {
      onState?.(false, 'listening stopped');
    }
  };

  try {
    recognition.start();
    onState?.(true);
  } catch (err) {
    onState?.(false, (err as Error).message);
  }

  return {
    stop: () => {
      stopped = true;
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}
