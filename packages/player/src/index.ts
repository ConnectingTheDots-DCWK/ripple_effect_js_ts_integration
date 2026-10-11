// @ripplefx/player — the Ripple Effect engine in a page, or in Node.
//
//   const campaign = await Campaign.load('/the-city-of-elsenmar/');
//   const player = new Player(campaign.session({ seed: 7 }), { onEffect: show });
//   player.start();
//
// ADR *a-campaign-plays-in-a-page* in the engine's repository is why it is
// shaped as it is; README.md is how to use it.
export {
  type BundleEntry,
  type BundleFiles,
  Campaign,
  type CampaignManifest,
  type CampaignOptions,
} from './campaign.js';
export {
  type Ambience,
  type AudioCommand,
  type CallbackEvent,
  type Changed,
  type Choice,
  type CvarSnapshot,
  type Effect,
  type Entity,
  type Memory,
  type Passage,
  type Prompt,
  type PromptField,
  resolveLink,
  type Soundscape,
  type Track,
  type Turn,
} from './effects.js';
export type { EngineOptions, Variant } from './engine.js';
export {
  BundleError,
  type BundleFailure,
  EngineTrap,
  HostError,
  type HostFailure,
  LoadError,
  NeedsPython,
  ResumeError,
  type ResumeFailure,
  RippleError,
} from './errors.js';
export { encodePath } from './media.js';
export {
  type CallbackHandler,
  isTurn,
  Player,
  type PlayerHandlers,
  ReentrantVerb,
} from './player.js';
export {
  type Answers,
  type GuardReport,
  type Paused,
  type PythonFailure,
  type PythonResult,
  type ResumeStart,
  type ScriptLimits,
  Session,
  type SessionOptions,
  type SessionStart,
} from './session.js';
export { SoundscapeDriver, type SoundscapeOptions } from './soundscape.js';
export type { Speaker, Voice, VoicePlay, VoiceRole } from './speaker.js';
export { asRecord, type RippleValue } from './values.js';
