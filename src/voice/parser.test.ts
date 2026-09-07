/**
 * The parser decides what a spoken ball was worth, so it is held to the same
 * standard as the engine: it must be right, and where it cannot be sure it
 * must say so rather than guess.
 */

import { describe, expect, it } from 'vitest';
import { matchPlayer, parseCommand, type Player } from './parser';

const SQUAD: Player[] = [
  { id: 'p1', name: 'Amit yadav' },
  { id: 'p2', name: 'Akarsha K N' },
  { id: 'p3', name: 'Abhay D' },
  { id: 'p4', name: 'Vaibhav' },
  { id: 'p5', name: 'Aadi K' },
  { id: 'p6', name: 'Shreyas M' },
];
const ctx = { squad: SQUAD };

describe('the ball', () => {
  it('reads the phrases a scorer actually says', () => {
    expect(parseCommand('wide', ctx)).toMatchObject({ kind: 'ball', patch: { extra: 'wide' } });
    expect(parseCommand('no ball 6 runs', ctx)).toMatchObject({
      kind: 'ball',
      patch: { extra: 'noball', declared: 6, contact: 'direct' },
    });
    expect(parseCommand('amit runs 1 and 1 d', ctx)).toMatchObject({
      kind: 'ball',
      patch: { physical: 1, declared: 1, contact: 'pitched' },
    });
    expect(parseCommand('dot ball', ctx)).toMatchObject({ kind: 'ball', patch: { declared: 0 } });
  });

  it('knows which row a declared value belongs to', () => {
    // 1 and 3 are pitched only; 4 and 6 direct only.
    expect(parseCommand('3 declare', ctx)).toMatchObject({ patch: { contact: 'pitched' } });
    expect(parseCommand('4 declare', ctx)).toMatchObject({ patch: { contact: 'direct' } });
  });

  it('refuses to guess on two, because it is on both rows', () => {
    expect(parseCommand('2 declare', ctx).kind).toBe('ambiguous');
    // Said properly, it is fine.
    expect(parseCommand('2 declare direct', ctx)).toMatchObject({ patch: { contact: 'direct' } });
    expect(parseCommand('2 pitched', ctx)).toMatchObject({ patch: { contact: 'pitched' } });
  });
});

describe('wickets, bowlers and batsmen', () => {
  it('reads a dismissal and who took the catch', () => {
    expect(parseCommand('akarsha bowled out', ctx)).toMatchObject({ kind: 'wicket', type: 'bowled' });
    const caught = parseCommand('amit caught by abhay', ctx);
    expect(caught).toMatchObject({ kind: 'wicket', type: 'caught' });
    if (caught.kind === 'wicket') expect(caught.fielderId).toBe('p3');
  });

  it('reads who is coming on', () => {
    expect(parseCommand('vaibhav comes to bowl', ctx)).toMatchObject({ kind: 'bowler', playerId: 'p4' });
    expect(parseCommand('next batsman is aadi', ctx)).toMatchObject({
      kind: 'newBatsman',
      playerId: 'p5',
    });
  });
});

describe('control', () => {
  it('takes the words for undo, save and the impact over', () => {
    expect(parseCommand('undo', ctx).kind).toBe('undo');
    expect(parseCommand('save', ctx).kind).toBe('commit');
    expect(parseCommand('impact over', ctx)).toMatchObject({ kind: 'impactOver', on: true });
    expect(parseCommand('cancel impact over', ctx)).toMatchObject({ kind: 'impactOver', on: false });
    expect(parseCommand('switch strike', ctx).kind).toBe('switchStrike');
  });

  it('says it did not understand rather than inventing a ball', () => {
    expect(parseCommand('what is the score', ctx).kind).toBe('unknown');
    expect(parseCommand('', ctx).kind).toBe('unknown');
  });
});

describe('names', () => {
  it('matches a mangled name against the squad', () => {
    expect(matchPlayer('amith', SQUAD)?.id).toBe('p1');
    expect(matchPlayer('vaibav', SQUAD)?.id).toBe('p4');
  });

  it('refuses a name that is nothing like anyone in the squad', () => {
    expect(matchPlayer('christopher', SQUAD)).toBeNull();
  });
});
