// What can go wrong, as classes a host can tell apart with `instanceof`.
//
// The engine answers a refusal as a WIT `result`, which jco throws as a
// `ComponentError` carrying the variant in `payload`. Each is rethrown here as
// the error that names it, keeping the engine's structure: a host that wants
// the sentence has `message`, and one that wants to act has `failure`.
import type * as bundle from '../generated/no-python/interfaces/ripple-engine-bundle.js';
import type * as session from '../generated/no-python/interfaces/ripple-engine-session.js';

/** Every error this package throws. */
export class RippleError extends Error {
  override name = 'RippleError';
}

/** Why a bundle would not open: unreadable, or from a newer engine. */
export type BundleFailure =
  | { readonly kind: 'format'; readonly message: string; readonly location?: string }
  | {
      readonly kind: 'version';
      readonly message: string;
      readonly found: number;
      readonly supported: number;
      readonly oldest?: number;
    };

/** The bundle is not one this engine can open. */
export class BundleError extends RippleError {
  override name = 'BundleError';
  constructor(readonly failure: BundleFailure) {
    super(failure.message);
  }
}

/** A verb the story was not waiting for, or a choice it does not offer. */
export type HostFailure =
  | {
      readonly kind: 'wrong-turn';
      readonly asked: session.TurnKind;
      readonly answered: session.Verb;
    }
  | { readonly kind: 'no-such-choice'; readonly offered: number; readonly chosen: number }
  | { readonly kind: 'choice-spent'; readonly port: string }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'nothing-asked' }
  | { readonly kind: 'unknown-locale'; readonly locale: string };

/** The host called a verb out of turn — a bug in the host, not the story. */
export class HostError extends RippleError {
  override name = 'HostError';
  constructor(readonly failure: HostFailure) {
    super(describeHostFailure(failure));
  }
}

/** Why a save could not be resumed against this campaign. */
export type ResumeFailure =
  | { readonly kind: 'bundle'; readonly failure: BundleFailure }
  | { readonly kind: 'board-gone'; readonly board: string }
  | { readonly kind: 'node-gone'; readonly board: string; readonly node: string };

/** The save does not fit this campaign any more. */
export class ResumeError extends RippleError {
  override name = 'ResumeError';
  constructor(readonly failure: ResumeFailure) {
    super(
      failure.kind === 'bundle'
        ? failure.failure.message
        : failure.kind === 'board-gone'
          ? `the board ${failure.board} is not in this campaign any more`
          : `the node ${failure.node} is not on ${failure.board} any more`,
    );
  }
}

/** The campaign uses Python, and the host loaded the engine without it. */
export class NeedsPython extends RippleError {
  override name = 'NeedsPython';
  constructor() {
    super('this campaign uses Python, and the engine was loaded without it');
  }
}

/** A file the campaign is made of could not be fetched. */
export class LoadError extends RippleError {
  override name = 'LoadError';
  constructor(
    readonly url: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The engine panicked. The instance it ran in is unusable from here on, and
 * every later call on the same campaign throws this again: load the campaign
 * afresh and resume the last save.
 */
export class EngineTrap extends RippleError {
  override name = 'EngineTrap';
  constructor(cause: unknown) {
    super(`the engine stopped: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

export function bundleFailure(raw: bundle.BundleFailure): BundleFailure {
  if (raw.tag === 'format') {
    return {
      kind: 'format',
      message: raw.val.message,
      ...(raw.val.location === undefined ? {} : { location: raw.val.location }),
    };
  }
  return {
    kind: 'version',
    message: raw.val.message,
    found: Number(raw.val.found),
    supported: Number(raw.val.supported),
    ...(raw.val.oldest === undefined ? {} : { oldest: Number(raw.val.oldest) }),
  };
}

export function hostFailure(raw: session.HostFailure): HostFailure {
  switch (raw.tag) {
    case 'wrong-turn':
      return { kind: 'wrong-turn', asked: raw.val.asked, answered: raw.val.answered };
    case 'no-such-choice':
      return { kind: 'no-such-choice', offered: raw.val.offered, chosen: raw.val.chosen };
    case 'choice-spent':
      return { kind: 'choice-spent', port: raw.val };
    case 'stopped':
      return { kind: 'stopped' };
    case 'nothing-asked':
      return { kind: 'nothing-asked' };
    case 'unknown-locale':
      return { kind: 'unknown-locale', locale: raw.val };
  }
}

export function resumeFailure(raw: session.ResumeFailure): ResumeFailure {
  switch (raw.tag) {
    case 'bundle':
      return { kind: 'bundle', failure: bundleFailure(raw.val) };
    case 'board-gone':
      return { kind: 'board-gone', board: raw.val };
    case 'node-gone':
      return { kind: 'node-gone', board: raw.val.board, node: raw.val.node };
  }
}

function describeHostFailure(failure: HostFailure): string {
  switch (failure.kind) {
    case 'wrong-turn':
      return `the story is at a ${failure.asked} and was answered with ${failure.answered}`;
    case 'no-such-choice':
      return `choice ${failure.chosen} was taken where ${failure.offered} are offered`;
    case 'choice-spent':
      return `the choice ${failure.port} has run out`;
    case 'stopped':
      return 'the session is stopped';
    case 'nothing-asked':
      return 'the story is not waiting for anything';
    case 'unknown-locale':
      return `the campaign has no language ${failure.locale}`;
  }
}
