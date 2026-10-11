// A campaign played in a page: what the editor's play window does, written
// against the published packages and nothing else. It is the example a
// developer starts from, and the listening pass for the soundscape speaker —
// a test can count voices, and only a person can hear a seam.
import {
  Campaign,
  type Effect,
  type Passage,
  Player,
  type Prompt,
  resolveLink,
  SoundscapeDriver,
} from '@ripplefx/player';
import { WebAudioSpeaker } from '@ripplefx/soundscape';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const stage = document.querySelector<HTMLElement>('#stage')!;
const picker = document.querySelector<HTMLSelectElement>('#campaign')!;
const languages = document.querySelector<HTMLSelectElement>('#locale')!;
const mute = document.querySelector<HTMLButtonElement>('#mute')!;
const restart = document.querySelector<HTMLButtonElement>('#restart')!;

// The passage being drawn, for the image hook below to resolve against.
let drawing: Passage | undefined;
const markdown = new Marked({
  walkTokens(token) {
    // A picture keeps the author's own link in the prose; the passage says
    // which file of the bundle that is.
    if (token.type === 'image' && drawing) token.href = resolveLink(drawing, token.href);
  },
});

let campaign: Campaign | undefined;
let player: Player | undefined;
let audio: SoundscapeDriver | undefined;
const speaker = new WebAudioSpeaker();

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function note(text: string): HTMLElement {
  const paragraph = element('p', text);
  paragraph.className = 'note';
  return paragraph;
}

function prose(passage: Passage): HTMLElement {
  drawing = passage;
  const html =
    campaign?.manifest.textFormat === 'html'
      ? passage.text
      : (markdown.parse(passage.text, { async: false }) as string);
  drawing = undefined;
  const body = element('div');
  body.className = 'prose';
  // Whatever the author wrote is sanitised before it is a page: a bundle
  // exported as HTML hands over HTML.
  body.innerHTML = DOMPurify.sanitize(html);
  return body;
}

function showPassage(passage: Passage): void {
  stage.replaceChildren();
  if (passage.untranslated) {
    stage.append(note(`This passage has no ${passage.untranslated} text yet.`));
  }
  stage.append(prose(passage));
  const choices = element('div');
  choices.className = 'choices';
  const offered = passage.choices.length ? passage.choices : [];
  offered.forEach((choice, index) => {
    const button = element('button');
    button.type = 'button';
    if (index < 9) button.append(element('kbd', String(index + 1)));
    button.append(choice.text || 'Continue');
    button.disabled = !choice.available;
    button.onclick = () => player?.choose(index);
    choices.append(button);
  });
  if (!offered.length) {
    const button = element('button', 'Continue');
    button.onclick = () => player?.choose();
    choices.append(button);
  }
  stage.append(choices);
}

function showPrompt(prompt: Prompt): void {
  stage.replaceChildren(element('h2', prompt.title));
  const form = element('form');
  for (const field of prompt.fields) {
    const label = element('label', field.name);
    const input = element('input');
    input.name = field.name;
    if (field.type === 'bool') input.type = 'checkbox';
    else if (field.type === 'int' || field.type === 'float') input.type = 'number';
    if (field.default !== null && typeof field.default !== 'object')
      input.value = String(field.default);
    label.append(input);
    form.append(label);
  }
  const submit = element('button', 'Continue');
  submit.className = 'primary';
  form.append(submit);
  form.onsubmit = (event) => {
    event.preventDefault();
    const values: Record<string, string | boolean | number | bigint> = {};
    for (const field of prompt.fields) {
      const input = form.elements.namedItem(field.name) as HTMLInputElement;
      values[field.name] =
        field.type === 'bool'
          ? input.checked
          : field.type === 'int'
            ? BigInt(Math.trunc(Number(input.value || 0)))
            : field.type === 'float'
              ? Number(input.value || 0)
              : input.value;
    }
    player?.answer(values);
  };
  stage.append(form);
}

function showHold(ms: number): void {
  const bar = element('div');
  bar.className = 'hold';
  const fill = element('div');
  bar.append(fill);
  stage.append(bar);
  fill.animate([{ width: '0%' }, { width: '100%' }], { duration: ms, fill: 'forwards' });
}

function onEffect(effect: Effect): void {
  switch (effect.kind) {
    case 'show':
      showPassage(effect.passage);
      break;
    case 'ask':
      showPrompt(effect.prompt);
      break;
    case 'hold':
      showHold(effect.ms);
      break;
    case 'ended':
      stage.replaceChildren(
        element('h2', effect.ranOut ? 'The story ran out of road.' : (effect.title ?? 'The End')),
      );
      break;
    case 'failed':
      stage.replaceChildren(element('h2', 'The story stopped.'), element('p', effect.message));
      break;
    default:
      // The sound is the driver's, handed over by the Player; jumps, changes
      // and callbacks are a host's to use and this one has no use for them.
      break;
  }
}

async function open(name: string): Promise<void> {
  player?.dispose();
  audio?.dispose();
  stage.replaceChildren(element('p', 'Loading…'));
  try {
    campaign = await Campaign.load(`/${encodeURIComponent(name)}/`);
  } catch (error) {
    stage.replaceChildren(
      element('h2', 'This campaign would not open.'),
      element('p', (error as Error).message),
    );
    return;
  }
  const project = campaign.manifest.project;
  languages.replaceChildren(...project.locales.map((locale) => new Option(locale, locale)));
  languages.value = project.defaultLocale;
  languages.hidden = project.locales.length < 2;
  stage.replaceChildren();
  const cover = campaign.coverUrl;
  if (cover) {
    const image = element('img');
    image.className = 'cover';
    image.src = cover.href;
    image.alt = '';
    stage.append(image);
  }
  stage.append(element('h1', project.title), element('p', project.description));
  stage.append(
    note(
      `${campaign.variant === 'python' ? 'Engine with Python' : 'Engine without Python'}, ${campaign.engineVersion}`,
    ),
  );
  const begin = element('button', 'Begin');
  begin.className = 'primary';
  // The gesture every browser asks for before a page makes a sound.
  begin.onclick = async () => {
    await speaker.unlock();
    start(languages.value);
  };
  stage.append(begin);
}

function start(locale: string): void {
  if (!campaign) return;
  player?.dispose();
  audio?.dispose();
  audio = new SoundscapeDriver(campaign, speaker, { muted: mute.dataset.muted === 'true' });
  player = new Player(campaign.session({ seed: BigInt(Date.now()), locale }), {
    onEffect,
    audio,
    onError: (error) => onEffect({ kind: 'failed', message: (error as Error).message }),
  });
  mute.hidden = false;
  restart.hidden = false;
  // For a developer's console, and the example's own end-to-end check.
  if (import.meta.env.DEV) Object.assign(window, { ripple: { campaign, player, audio, speaker } });
  player.start();
}

mute.onclick = () => {
  const muted = mute.dataset.muted !== 'true';
  mute.dataset.muted = String(muted);
  mute.textContent = muted ? 'Unmute' : 'Mute';
  audio?.setMuted(muted);
};
restart.onclick = () => player?.restart();
languages.onchange = () => player?.setLocale(languages.value);
picker.onchange = () => void open(picker.value);

// A hidden tab is not listening: the sound holds where it is.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio?.pause();
  else audio?.resume();
});

document.addEventListener('keydown', (event) => {
  const turn = player?.turn;
  if (turn?.kind !== 'show' || event.target instanceof HTMLInputElement) return;
  const index = Number(event.key) - 1;
  if (index >= 0 && index < Math.min(9, turn.passage.choices.length)) player?.choose(index);
});

const names: string[] = await fetch('/campaigns.json').then((response) => response.json());
picker.replaceChildren(...names.map((name) => new Option(name, name)));
if (names.length) void open(names[0]!);
else
  stage.replaceChildren(
    element('p', 'No campaigns: set RIPPLE_CAMPAIGNS to a folder of compiled bundles.'),
  );
