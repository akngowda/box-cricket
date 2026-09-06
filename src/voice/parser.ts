/**
 * Spoken (or typed) scoring, turned into commands.
 *
 * Cricket scoring is a small closed grammar — a few verbs, the numbers one to
 * six, a fixed list of dismissals, and names that are already known because
 * they are in the squad. So this is a parser, not a language model: pure,
 * deterministic, testable, and it works with no network, which matters because
 * the ground has none.
 *
 * It never decides anything by itself. A phrase it cannot read comes back as
 * `unknown`, and one that could mean two things comes back as `ambiguous` with
 * the reason — because a mis-heard ball written silently is worse than no
 * voice at all.
 */

import type { Contact, DeclaredRuns, ExtraType, WicketType } from '../engine/types';

export interface Player {
  id: string;
  name: string;
}

/** What the pad should show, before anyone commits it. */
export interface BallPatch {
  declared?: DeclaredRuns;
  contact?: Contact;
  physical?: number;
  extra?: ExtraType;
  body?: boolean;
}

export type Command =
  | { kind: 'ball'; patch: BallPatch; say: string }
  | { kind: 'wicket'; type: WicketType; playerId?: string; fielderId?: string; say: string }
  | { kind: 'newBatsman'; playerId: string; say: string }
  | { kind: 'bowler'; playerId: string; say: string }
  | { kind: 'impactOver'; on: boolean; say: string }
  | { kind: 'switchStrike'; say: string }
  | { kind: 'commit'; say: string }
  | { kind: 'undo'; say: string }
  | { kind: 'clear'; say: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unknown'; text: string };

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const NUMBERS: Record<string, number> = {
  zero: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, tree: 3, four: 4, for: 4,
  five: 5, six: 6, sixe: 6, seven: 7, eight: 8, nine: 9,
};

/** Recognition mangles these constantly, so they are matched loosely. */
const EXTRAS: Array<[RegExp, ExtraType]> = [
  [/\b(wide|wides|wide ball|white ball)\b/, 'wide'],
  [/\b(no ?ball|nb|noble|no balls)\b/, 'noball'],
];

const DISMISSALS: Array<[RegExp, WicketType]> = [
  [/\b(bowled|bold|b out)\b/, 'bowled'],
  [/\b(caught|court|catch|c out)\b/, 'caught'],
  [/\b(run ?out)\b/, 'runout'],
  [/\b(stumped|stump)\b/, 'stumped'],
  [/\b(hit ?wicket)\b/, 'hitwicket'],
  [/\b(retired ?hurt)\b/, 'retired_hurt'],
  [/\b(retired ?out|retired)\b/, 'retired_out'],
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A number, whether it was said as a word or a digit. */
function numberIn(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBERS[word] ?? null;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      (rows[i] as number[])[j] = Math.min(
        (rows[i - 1] as number[])[j]! + 1,
        (rows[i] as number[])[j - 1]! + 1,
        (rows[i - 1] as number[])[j - 1]! + cost,
      );
    }
  }
  return (rows[a.length] as number[])[b.length]!;
}

/**
 * Match a spoken name against the squad.
 *
 * Recognition mangles Indian names badly on an open vocabulary, so this only
 * ever chooses from the players actually in this match — a list of sixteen,
 * not a dictionary — and it refuses when two are too close to call.
 */
export function matchPlayer(text: string, squad: readonly Player[]): Player | null {
  const words = normalise(text).split(' ');
  let best: { player: Player; score: number } | null = null;
  let runnerUp = Infinity;

  for (const player of squad) {
    const target = normalise(player.name);
    const parts = target.split(' ');
    let score = Infinity;

    // Compare against the whole name, each of its parts, and every window of
    // spoken words the same length as the name.
    for (const candidate of [target, ...parts]) {
      for (let i = 0; i < words.length; i += 1) {
        for (let len = 1; len <= 3 && i + len <= words.length; len += 1) {
          const heard = words.slice(i, i + len).join(' ');
          const d = distance(heard, candidate) / Math.max(candidate.length, heard.length);
          if (d < score) score = d;
        }
      }
    }

    if (best === null || score < best.score) {
      runnerUp = best?.score ?? Infinity;
      best = { player, score };
    } else if (score < runnerUp) {
      runnerUp = score;
    }
  }

  if (!best || best.score > 0.34) return null;
  // Too close between two players to be sure — better to ask than to guess.
  if (runnerUp - best.score < 0.08) return null;
  return best.player;
}

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

export interface ParseContext {
  /** Everyone who could be named: both squads. */
  squad: readonly Player[];
  /** Those who could come in next, for "next batsman is …". */
  available?: readonly Player[];
  /** Those who could bowl, for "… comes to bowl". */
  bowlers?: readonly Player[];
}

export function parseCommand(input: string, ctx: ParseContext): Command {
  const text = normalise(input);
  if (text === '') return { kind: 'unknown', text: input };

  // --- controls, checked first: they are short and unambiguous -------------
  if (/\b(undo|cancel that|scratch that|remove last)\b/.test(text))
    return { kind: 'undo', say: 'undone' };
  if (/\b(clear|reset|start again)\b/.test(text)) return { kind: 'clear', say: 'cleared' };
  if (/\b(save|score it|commit|confirm|done|next ball)\b/.test(text))
    return { kind: 'commit', say: 'saved' };
  if (/\b(switch|swap)\b.*\b(strike|side|ends?)\b/.test(text))
    return { kind: 'switchStrike', say: 'strike switched' };

  // --- impact over ---------------------------------------------------------
  if (/\bimpact\b/.test(text)) {
    const off = /\b(cancel|undo|remove|stop|off|no)\b/.test(text);
    return { kind: 'impactOver', on: !off, say: off ? 'impact over cancelled' : 'impact over' };
  }

  // --- who bowls next ------------------------------------------------------
  if (/\b(comes to bowl|to bowl|will bowl|bowling now|next bowler)\b/.test(text)) {
    const who = matchPlayer(text, ctx.bowlers ?? ctx.squad);
    return who
      ? { kind: 'bowler', playerId: who.id, say: `${who.name} to bowl` }
      : { kind: 'ambiguous', reason: 'I did not catch which bowler' };
  }

  // --- who comes in next ---------------------------------------------------
  if (/\b(next batsman|next batter|new batsman|new batter|comes in|walks in)\b/.test(text)) {
    const who = matchPlayer(text, ctx.available ?? ctx.squad);
    return who
      ? { kind: 'newBatsman', playerId: who.id, say: `${who.name} in` }
      : { kind: 'ambiguous', reason: 'I did not catch which batsman' };
  }

  // --- dismissals ----------------------------------------------------------
  for (const [pattern, type] of DISMISSALS) {
    if (!pattern.test(text)) continue;

    // "caught by abhay" — the fielder follows "by".
    let fielderId: string | undefined;
    const by = text.split(/\bby\b/)[1];
    if (by) fielderId = matchPlayer(by, ctx.squad)?.id;

    // The batsman is whoever is named before the dismissal word.
    const before = text.split(pattern)[0] ?? '';
    const playerId = matchPlayer(before, ctx.squad)?.id;

    return {
      kind: 'wicket',
      type,
      ...(playerId ? { playerId } : {}),
      ...(fielderId ? { fielderId } : {}),
      say: 'out',
    };
  }

  // --- runs ----------------------------------------------------------------
  const patch: BallPatch = {};
  let heard = false;

  for (const [pattern, extra] of EXTRAS) {
    if (pattern.test(text)) {
      patch.extra = extra;
      heard = true;
    }
  }

  if (/\b(body|pad|hit the pad)\b/.test(text)) {
    patch.body = true;
    heard = true;
  }

  if (/\b(dot|dot ball|no run|nothing)\b/.test(text) && !heard) {
    return { kind: 'ball', patch: { declared: 0, physical: 0, extra: 'none' }, say: 'dot ball' };
  }

  // "runs a single", "runs 2" — running is said with a verb; the declared
  // value is said with "declare", "d", or on its own.
  const words = text.split(' ');
  let declared: number | null = null;
  let physical: number | null = null;

  if (/\b(single)\b/.test(text)) physical = 1;

  for (let i = 0; i < words.length; i += 1) {
    const n = numberIn(words[i] as string);
    if (n === null) continue;

    const after = words.slice(i + 1, i + 3).join(' ');
    const before = words.slice(Math.max(0, i - 3), i).join(' ');

    if (/\b(d|declare|declared|zone)\b/.test(after) || /\b(hits?|hit)\b/.test(before)) {
      declared = n;
    } else if (/\b(ran|runs?|running|took)\b/.test(before) || /\b(ran|run|runs)\b/.test(after)) {
      physical = n;
    } else if (patch.extra !== undefined) {
      // "no ball 6" — a number beside an extra is what came off the bat.
      declared = n;
    } else if (declared === null) {
      declared = n;
    }
    heard = true;
  }

  if (physical !== null) {
    patch.physical = physical;
    heard = true;
  }

  if (declared !== null) {
    if (![0, 1, 2, 3, 4, 6].includes(declared)) {
      return { kind: 'ambiguous', reason: `${declared} is not a declared value` };
    }
    // 1 and 3 are pitched only; 4 and 6 direct only; 2 could be either, and
    // guessing would put the ball in the wrong zone.
    if (declared === 2 && !/\b(pitch|pitched|bounce|bounced|direct|full|fly)\b/.test(text)) {
      return {
        kind: 'ambiguous',
        reason: 'two could be pitched or direct — say "two pitched" or "two direct"',
      };
    }
    const contact: Contact =
      declared === 0
        ? 'none'
        : declared === 2
          ? /\b(direct|full|fly)\b/.test(text)
            ? 'direct'
            : 'pitched'
          : declared === 1 || declared === 3
            ? 'pitched'
            : 'direct';
    patch.declared = declared as DeclaredRuns;
    patch.contact = contact;
  }

  if (!heard) return { kind: 'unknown', text: input };

  const bits: string[] = [];
  if (patch.extra === 'wide') bits.push('wide');
  if (patch.extra === 'noball') bits.push('no ball');
  if (patch.body) bits.push('body');
  if (patch.declared !== undefined && patch.declared > 0) bits.push(`${patch.declared}`);
  if (patch.physical) bits.push(`${patch.physical} ran`);
  return { kind: 'ball', patch, say: bits.join(', ') || 'dot ball' };
}
