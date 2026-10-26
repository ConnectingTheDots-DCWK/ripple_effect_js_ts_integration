// What a verb answers: the engine's effects, spelled for TypeScript.
//
// jco hands each effect over as `{ tag, val }`. Here every one is a plain
// object tagged on `kind`, with its fields beside it, so a host's `switch`
// over `effect.kind` is checked for exhaustiveness and reads like the host
// API (`campaign-host-api.md` §4a). Times and indices are numbers; a story's
// values are `RippleValue`s; a picture or a sound comes with its URL. The
// one exception is a `trace` effect's event, which is the engine's own
// `RunEvent` as jco spells it — a debugging view, passed through unmapped.
import type * as bundle from '../generated/no-python/interfaces/ripple-engine-bundle.js';
import type * as campaign from '../generated/no-python/interfaces/ripple-engine-campaign.js';
import type * as session from '../generated/no-python/interfaces/ripple-engine-session.js';
import { fromArena, type RippleValue } from './values.js';

/** One effect, in the order the engine produced it. */
export type Effect =
  | { readonly kind: 'show'; readonly passage: Passage }
  | { readonly kind: 'ask'; readonly prompt: Prompt }
  /**
   * The story has not begun: it reads these of the world outside it, and
   * nobody has answered. Answer each with `permit`; the answer to the last
   * begins the story (`campaign-host-api.md` §7a).
   */
  | { readonly kind: 'permit'; readonly kinds: readonly PermissionKind[] }
  /** A read of the world outside the story did not get the real value. Not a turn. */
  | { readonly kind: 'notice'; readonly notice: Notice }
  | { readonly kind: 'hold'; readonly ms: number }
  | { readonly kind: 'ended'; readonly title?: string; readonly ranOut: boolean }
  /** The story stopped on an error. `message` is the engine's English, for showing and never for parsing. */
  | { readonly kind: 'failed'; readonly message: string; readonly node?: string }
  | { readonly kind: 'stopped' }
  /** The story moved to another board: `board` indexes `campaign.manifest.boards`, not its catalog id. */
  | { readonly kind: 'jumped'; readonly board: number; readonly node?: string }
  | { readonly kind: 'ambience'; readonly ambience: Ambience | null }
  | { readonly kind: 'audio'; readonly command: AudioCommand }
  | ({ readonly kind: 'changed' } & Changed)
  | { readonly kind: 'callback'; readonly event: CallbackEvent }
  /** Only with `trace` on. The event keeps the engine's `{ tag, val }` shape, kebab-case tags and all. */
  | { readonly kind: 'trace'; readonly event: RunEvent };

/** One step of the run trace, as the engine's world spells it. */
export type RunEvent = session.RunEvent;
/** How a track of a soundscape plays: `auto`, `looping` or `once`, as the world spells it. */
export type TrackMode = bundle.TrackMode;
/** A callback's kind as the WIT world spells it (`cvar-changed`); `CallbackEventName` is the dotted one. */
export type CallbackKind = session.CallbackKind;

/** The effects that say where the story now is — always the last of a batch. */
export type Turn = Extract<
  Effect,
  { kind: 'show' | 'ask' | 'permit' | 'hold' | 'ended' | 'failed' | 'stopped' }
>;

/**
 * What a story may read of the world outside it, as the host API and the
 * manifest's `permissions` spell it — `dateTime`, not the WIT world's
 * `date-time`. The microphone is not one.
 */
export type PermissionKind = 'dateTime' | 'location';

// Tables both ways, as for the callbacks below, so a kind the world adds
// fails the typecheck here.
const PERMISSION_KINDS: Record<session.PermissionKind, PermissionKind> = {
  'date-time': 'dateTime',
  location: 'location',
};
const WIT_PERMISSION_KINDS: Record<PermissionKind, session.PermissionKind> = {
  dateTime: 'date-time',
  location: 'location',
};

/** A kind as the WIT world spells it, for a call into the engine. */
export function toWitPermission(kind: PermissionKind): session.PermissionKind {
  const wit = WIT_PERMISSION_KINDS[kind];
  if (wit === undefined) throw new TypeError(`${String(kind)} is not a kind a story may ask for`);
  return wit;
}

export function fromWitPermission(kind: session.PermissionKind): PermissionKind {
  return PERMISSION_KINDS[kind];
}

/**
 * A read of the clock or the position that did not get the real value. Said
 * once per kind and outcome in a playthrough, before the turn of the read.
 */
export interface Notice {
  /**
   * The playthrough code, its letter the severity: `I.RT.05` a stand-in
   * answered, `W.RT.06` the read was refused, `I.RT.07` the host had
   * nothing to give.
   */
  readonly code: string;
  readonly kind: PermissionKind;
  /** The node whose read it was. */
  readonly node?: string;
  /** The engine's English sentence, for showing and never for parsing. */
  readonly message: string;
}

/**
 * A passage's countdown — `campaign-host-api.md` §4b. The engine keeps no
 * time for it: a host waits `afterMs`, says `beginCountdown`, waits
 * `timeoutMs` and says `expire`. A `Player` does all of that itself.
 */
export interface ChoiceTimer {
  /** How long before the countdown begins, in ms; zero is at once. */
  readonly afterMs: number;
  /** How long it runs once begun, in ms; never zero. */
  readonly timeoutMs: number;
  /** Whether the author meant the reader to see it count. */
  readonly visible: boolean;
  /** The index into `choices` taken when it runs out. */
  readonly default: number;
}

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
   * file is — a URL, where the engine itself answers a media index. The
   * prose keeps the author's own links; `resolveLink` rewrites one through
   * this.
   */
  readonly media: ReadonlyMap<string, URL>;
  /** The same links, to the media index each names. */
  readonly mediaIndex: ReadonlyMap<string, number>;
  /** The language the passage has no text in, when that is why it is empty. */
  readonly untranslated?: string;
  readonly soundscape?: Soundscape;
  /** The passage asks for silence. */
  readonly silence: boolean;
  /** The passage's countdown; absent for one that waits for ever. */
  readonly timer?: ChoiceTimer;
}

export interface PromptField {
  /** What an answer is keyed by: an ID, the same in every language. */
  readonly name: string;
  readonly type: string;
  /** What the control is filled in with — the answer if nobody edits it. Not a placeholder. */
  readonly default: RippleValue;
  /** What the reader is shown, in the language being read: `name` where the author wrote nothing. */
  readonly label: string;
  /** The hint drawn while the field is empty; empty for none. Never the answer. */
  readonly placeholder: string;
  /**
   * Whether the reader may leave it empty, which answers `null`. A field
   * that is not optional is required: a host does not submit it empty.
   */
  readonly optional: boolean;
  /**
   * The fixed answers to pick from, in order: one pick for a scalar type,
   * any number for a `…List`. Empty for a field the reader types into.
   * Answered with the picked options' `id`s, never their labels or values.
   */
  readonly options: readonly PromptOption[];
}

/** One fixed answer a prompt field offers. */
export interface PromptOption {
  /** What a host answers with; the same in every language. */
  readonly id: string;
  /** What the reader is shown, in the language being read. */
  readonly label: string;
  /** What the story is handed, of the field's type. */
  readonly value: RippleValue;
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

/** One clip on a soundscape's timeline. Every time is in milliseconds. */
export interface Track {
  readonly media: number;
  readonly lane: number;
  /** Where on the timeline the clip begins, in ms. */
  readonly start: number;
  /** Where in the file it begins and ends, in ms. */
  readonly clipStart: number;
  readonly clipEnd?: number;
  readonly volume: number;
  readonly speed: number;
  /** The clip's own fades, in ms. */
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly mode: TrackMode;
  /** For `auto` only: the silence between one play ending and the next, in ms; zero is a gapless bed. */
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

/**
 * What a callback was declared on, as the author's `callbacks.json` and
 * `campaign-host-api.md` §5b spell it — `cvar.changed`, not the WIT world's
 * `cvar-changed`.
 */
export type CallbackEventName =
  | 'story.started'
  | 'board.entered'
  | 'soundscape.changed'
  | 'passage.shown'
  | 'choice.taken'
  | 'delay.started'
  | 'delay.elapsed'
  | 'story.ended'
  | 'story.failed'
  | 'cvar.changed'
  | 'entity.spawned'
  | 'entity.removed'
  | 'entity.renamed'
  | 'entity.field.changed'
  | 'machine.state.entered'
  | 'node.entered'
  | 'node.exited'
  | 'node.failed'
  | 'countdown.started'
  | 'countdown.expired';

// A table rather than a rewrite of the dashes, so a member the world adds
// fails the typecheck here instead of arriving spelled however it happens to.
const CALLBACK_EVENTS: Record<session.CallbackKind, CallbackEventName> = {
  'story-started': 'story.started',
  'board-entered': 'board.entered',
  'soundscape-changed': 'soundscape.changed',
  'passage-shown': 'passage.shown',
  'choice-taken': 'choice.taken',
  'delay-started': 'delay.started',
  'delay-elapsed': 'delay.elapsed',
  'story-ended': 'story.ended',
  'story-failed': 'story.failed',
  'cvar-changed': 'cvar.changed',
  'entity-spawned': 'entity.spawned',
  'entity-removed': 'entity.removed',
  'entity-renamed': 'entity.renamed',
  'entity-field-changed': 'entity.field.changed',
  'machine-state-entered': 'machine.state.entered',
  'node-entered': 'node.entered',
  'node-exited': 'node.exited',
  'node-failed': 'node.failed',
  'countdown-started': 'countdown.started',
  'countdown-expired': 'countdown.expired',
};

/**
 * A named callback the author declared — `campaign-host-api.md` §5b.
 * `callback` is the author's name for it, the key a handler is registered
 * under; `event` is what it was declared on:
 *
 *     player.onCallback('goldChanged', (fired) => fired.event); // 'cvar.changed'
 */
export interface CallbackEvent {
  readonly callback: string;
  readonly event: CallbackEventName;
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
    case 'permit':
      return { kind: 'permit', kinds: raw.val.map(fromWitPermission) };
    case 'notice':
      return { kind: 'notice', notice: toNotice(raw.val) };
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
    ...optional('timer', raw.timer && toTimer(raw.timer)),
  };
}

function toTimer(raw: campaign.ChoiceTimer): ChoiceTimer {
  return {
    afterMs: Number(raw.afterMs),
    timeoutMs: Number(raw.timeoutMs),
    visible: raw.visible,
    default: raw.default,
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
      label: field.label,
      placeholder: field.placeholder,
      optional: field.optional,
      options: field.options.map((option) => ({
        id: option.id,
        label: option.label,
        value: fromArena(option.value),
      })),
    })),
  };
}

function toNotice(raw: session.Notice): Notice {
  return {
    code: raw.code,
    kind: fromWitPermission(raw.kind),
    message: raw.message,
    ...optional('node', raw.node),
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
    event: CALLBACK_EVENTS[raw.event],
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
