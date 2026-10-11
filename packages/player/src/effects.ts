// What a verb answers: the engine's effects, spelled for TypeScript.
//
// jco hands each effect over as `{ tag, val }`. Here every one is a plain
// object tagged on `kind`, with its fields beside it, so a host's `switch`
// over `effect.kind` is checked for exhaustiveness and reads like the host
// API (`campaign-host-api.md` §4a). Times and indices are numbers; a story's
// values are `RippleValue`s; a picture or a sound comes with its URL.
import type * as bundle from '../generated/no-python/interfaces/ripple-engine-bundle.js';
import type * as campaign from '../generated/no-python/interfaces/ripple-engine-campaign.js';
import type * as session from '../generated/no-python/interfaces/ripple-engine-session.js';
import { fromArena, type RippleValue } from './values.js';

/** One effect, in the order the engine produced it. */
export type Effect =
  | { readonly kind: 'show'; readonly passage: Passage }
  | { readonly kind: 'ask'; readonly prompt: Prompt }
  | { readonly kind: 'hold'; readonly ms: number }
  | { readonly kind: 'ended'; readonly title?: string; readonly ranOut: boolean }
  | { readonly kind: 'failed'; readonly message: string; readonly node?: string }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'jumped'; readonly board: number; readonly node?: string }
  | { readonly kind: 'ambience'; readonly ambience: Ambience | null }
  | { readonly kind: 'audio'; readonly command: AudioCommand }
  | ({ readonly kind: 'changed' } & Changed)
  | { readonly kind: 'callback'; readonly event: CallbackEvent }
  | { readonly kind: 'trace'; readonly event: session.RunEvent };

/** The effects that say where the story now is — always the last of a batch. */
export type Turn = Extract<
  Effect,
  { kind: 'show' | 'ask' | 'hold' | 'ended' | 'failed' | 'stopped' }
>;

export interface Choice {
  readonly port: string;
  readonly text: string;
  /** False for a choice that has run out: shown, and refused if taken. */
  readonly available: boolean;
}

export interface Passage {
  readonly node: string;
  readonly title: string;
  /** The prose, after its snippets ran, in the language being read. */
  readonly text: string;
  readonly choices: readonly Choice[];
  readonly snippets: readonly { readonly code: string; readonly isInline: boolean }[];
  /**
   * Every link in the prose that names a file of the campaign, to where that
   * file is. The prose keeps the author's own links; `resolveLink` rewrites
   * one through this.
   */
  readonly media: ReadonlyMap<string, URL>;
  /** The same links, to the media index each names. */
  readonly mediaIndex: ReadonlyMap<string, number>;
  /** The language the passage has no text in, when that is why it is empty. */
  readonly untranslated?: string;
  readonly soundscape?: Soundscape;
  /** The passage asks for silence. */
  readonly silence: boolean;
}

export interface PromptField {
  readonly name: string;
  readonly type: string;
  readonly default: RippleValue;
}

export interface Prompt {
  readonly node: string;
  readonly title: string;
  readonly fields: readonly PromptField[];
}

export interface Ambience {
  readonly soundscape: Soundscape;
  readonly board: number;
  readonly node: string;
}

export interface Track {
  readonly media: number;
  readonly lane: number;
  readonly start: number;
  readonly clipStart: number;
  readonly clipEnd?: number;
  readonly volume: number;
  readonly speed: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly mode: bundle.TrackMode;
  readonly interval: number;
}

/** A timeline of clips, in milliseconds — `campaign-bundle.md` §8.2. */
export interface Soundscape {
  readonly id: string;
  readonly name: string;
  readonly length: number;
  readonly looping: boolean;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly volume: number;
  readonly tied: boolean;
  readonly tracks: readonly Track[];
}

/** What a speaker is told — `host-audio-system.md` §2. */
export type AudioCommand =
  | { readonly kind: 'play'; readonly soundscape: Soundscape; readonly fadeInMs: number }
  | { readonly kind: 'stop'; readonly fadeOutMs: number }
  | { readonly kind: 'cut' }
  | {
      readonly kind: 'cue';
      readonly media: number;
      readonly url?: URL;
      readonly volume: number;
      readonly speed: number;
      readonly node?: string;
    };

export interface Entity {
  readonly key: string;
  readonly component?: string;
  readonly label: string;
  readonly values: RippleValue;
}

export interface Memory {
  readonly nodes: RippleValue;
  readonly machines: readonly (readonly [string, string])[];
}

export interface CvarSnapshot {
  readonly name: string;
  readonly type: string;
  readonly default: RippleValue;
  readonly value: RippleValue;
}

/** Which of the stores moved, each with its new contents. */
export interface Changed {
  readonly entities?: readonly Entity[];
  readonly memory?: Memory;
  readonly cvars?: readonly CvarSnapshot[];
}

/** A named callback the author declared — `campaign-host-api.md` §5b. */
export interface CallbackEvent {
  readonly callback: string;
  readonly event: session.CallbackKind;
  readonly board?: number;
  readonly node?: string;
  readonly name?: string;
  readonly from?: RippleValue;
  readonly to?: RippleValue;
  readonly index?: number;
}

/** What an effect needs from the campaign it came from. */
export interface MediaResolver {
  mediaUrl(index: number): URL | undefined;
}

/**
 * The engine's own soundscape record for each one handed out, so the
 * soundscape driver can give the mixer exactly what the engine gave.
 */
export const engineSoundscapes = new WeakMap<Soundscape, bundle.Soundscape>();

export function toEffects(raw: readonly session.Effect[], media: MediaResolver): Effect[] {
  return raw.map((effect) => toEffect(effect, media));
}

export function toEffect(raw: session.Effect, media: MediaResolver): Effect {
  switch (raw.tag) {
    case 'show':
      return { kind: 'show', passage: toPassage(raw.val, media) };
    case 'ask':
      return { kind: 'ask', prompt: toPrompt(raw.val) };
    case 'hold':
      return { kind: 'hold', ms: Number(raw.val) };
    case 'ended':
      return { kind: 'ended', ranOut: raw.val.ranOut, ...optional('title', raw.val.title) };
    case 'failed':
      return { kind: 'failed', message: raw.val.message, ...optional('node', raw.val.node) };
    case 'stopped':
      return { kind: 'stopped' };
    case 'jumped':
      return { kind: 'jumped', board: raw.val.board, ...optional('node', raw.val.node) };
    case 'ambience':
      return { kind: 'ambience', ambience: toAmbienceOrNull(raw.val) };
    case 'audio':
      return { kind: 'audio', command: toAudioCommand(raw.val, media) };
    case 'changed':
      return { kind: 'changed', ...toChanged(raw.val) };
    case 'callback':
      return { kind: 'callback', event: toCallback(raw.val) };
    case 'trace':
      return { kind: 'trace', event: raw.val };
  }
}

export function toPassage(raw: campaign.Passage, media: MediaResolver): Passage {
  const urls = new Map<string, URL>();
  const indices = new Map<string, number>();
  for (const [link, index] of raw.media) {
    indices.set(link, index);
    const url = media.mediaUrl(index);
    if (url) urls.set(link, url);
  }
  return {
    node: raw.node,
    title: raw.title,
    text: raw.text,
    choices: raw.choices.map(({ port, text, available }) => ({ port, text, available })),
    snippets: raw.snippets.map(({ code, isInline }) => ({ code, isInline })),
    media: urls,
    mediaIndex: indices,
    silence: raw.silence,
    ...optional('untranslated', raw.untranslated),
    ...optional('soundscape', raw.soundscape && toSoundscape(raw.soundscape)),
  };
}

export function toPrompt(raw: campaign.Prompt): Prompt {
  return {
    node: raw.node,
    title: raw.title,
    fields: raw.fields.map((field) => ({
      name: field.name,
      type: field.type,
      default: fromArena(field.default),
    })),
  };
}

export function toSoundscape(raw: bundle.Soundscape): Soundscape {
  const soundscape: Soundscape = {
    id: raw.id,
    name: raw.name,
    length: Number(raw.length),
    looping: raw.looping,
    fadeIn: Number(raw.fadeIn),
    fadeOut: Number(raw.fadeOut),
    volume: raw.volume,
    tied: raw.tied,
    tracks: raw.tracks.map((track) => ({
      media: Number(track.media),
      lane: Number(track.lane),
      start: Number(track.start),
      clipStart: Number(track.clipStart),
      ...optional('clipEnd', track.clipEnd === undefined ? undefined : Number(track.clipEnd)),
      volume: track.volume,
      speed: track.speed,
      fadeIn: Number(track.fadeIn),
      fadeOut: Number(track.fadeOut),
      mode: track.mode,
      interval: Number(track.interval),
    })),
  };
  engineSoundscapes.set(soundscape, raw);
  return soundscape;
}

export function toAmbienceOrNull(raw: campaign.Ambience | undefined): Ambience | null {
  return raw === undefined ? null : toAmbience(raw);
}

function toAmbience(raw: campaign.Ambience): Ambience {
  return { soundscape: toSoundscape(raw.soundscape), board: raw.board, node: raw.node };
}

function toAudioCommand(raw: session.AudioCommand, media: MediaResolver): AudioCommand {
  switch (raw.tag) {
    case 'play':
      return {
        kind: 'play',
        soundscape: toSoundscape(raw.val.soundscape),
        fadeInMs: Number(raw.val.fadeInMs),
      };
    case 'stop':
      return { kind: 'stop', fadeOutMs: Number(raw.val) };
    case 'cut':
      return { kind: 'cut' };
    case 'cue':
      return {
        kind: 'cue',
        media: raw.val.media,
        volume: raw.val.volume,
        speed: raw.val.speed,
        ...optional('url', media.mediaUrl(raw.val.media)),
        ...optional('node', raw.val.node),
      };
  }
}

export function toEntity(raw: session.Entity): Entity {
  return {
    key: raw.key,
    label: raw.label,
    values: fromArena(raw.values),
    ...optional('component', raw.component),
  };
}

export function toMemory(raw: session.Memory): Memory {
  return { nodes: fromArena(raw.nodes), machines: raw.machines };
}

export function toCvar(raw: session.CvarSnapshot): CvarSnapshot {
  return {
    name: raw.name,
    type: raw.type,
    default: fromArena(raw.default),
    value: fromArena(raw.value),
  };
}

function toChanged(raw: session.Changed): Changed {
  return {
    ...optional('entities', raw.entities?.map(toEntity)),
    ...optional('memory', raw.memory && toMemory(raw.memory)),
    ...optional('cvars', raw.cvars?.map(toCvar)),
  };
}

function toCallback(raw: session.CallbackEvent): CallbackEvent {
  return {
    callback: raw.callback,
    event: raw.event,
    ...optional('board', raw.board),
    ...optional('node', raw.node),
    ...optional('name', raw.name),
    ...optional('from', raw.from && fromArena(raw.from)),
    ...optional('to', raw.to && fromArena(raw.to)),
    ...optional('index', raw.index),
  };
}

/**
 * `{ [key]: value }` when there is one and `{}` when there is not, so an
 * absent field is absent rather than present and `undefined`.
 */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** Rewrites one link in a passage's prose to the URL of the file it names. */
export function resolveLink(passage: Passage, src: string): string {
  return passage.media.get(src)?.href ?? src;
}
