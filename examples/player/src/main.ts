// A campaign played in a page: what the editor's play window does, written
// against the published packages and nothing else. It is the example a
// developer starts from, and the listening pass for the soundscape speaker —
// a test can count voices, and only a person can hear a seam.
import {
  Campaign,
  type Countdown,
  type Effect,
  momentOf,
  type Passage,
  type PermissionKind,
  Player,
  type Prompt,
  type PromptField,
  type RippleValue,
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
// What the engine said about a read of the clock or the place since the last
// page, drawn above the next one.
const notices: string[] = [];
// The countdown being drawn, when it is begun and the author meant it seen.
let counting: { ends: number; ms: number } | undefined;

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

function notes(): HTMLElement[] {
  return notices.splice(0).map(note);
}

function button(text: string, onclick: () => void): HTMLButtonElement {
  const made = element('button', text);
  made.type = 'button';
  made.onclick = onclick;
  return made;
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
  stage.replaceChildren(...notes());
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
  // A change of language draws the page again, and the countdown runs on.
  drawCountdown();
}

// One field's control, and how to read it: `undefined` is left empty.
function control(field: PromptField): [HTMLElement, () => RippleValue | undefined] {
  const filled = (value: RippleValue) =>
    Array.isArray(field.default)
      ? field.default.some((item) => item === value)
      : field.default === value;
  if (field.options.length && field.type.endsWith('List')) {
    // Any number of the options, answered by their ids.
    const boxes = field.options.map((option) => {
      const box = element('input');
      box.type = 'checkbox';
      box.value = option.id;
      box.checked = filled(option.value);
      const label = element('label', option.label);
      label.className = 'option';
      label.prepend(box);
      return [label, box] as const;
    });
    const set = element('div');
    set.append(...boxes.map(([label]) => label));
    return [
      set,
      () => {
        const picked = boxes.filter(([, box]) => box.checked).map(([, box]) => box.value);
        return picked.length ? picked : undefined;
      },
    ];
  }
  if (field.options.length || (field.type === 'bool' && field.optional)) {
    // One of them, or none for a field that may be left empty: a truth that
    // may be left empty needs a third state, which a checkbox has not got.
    const select = element('select');
    if (field.optional) select.append(new Option('—', ''));
    if (field.options.length) {
      for (const option of field.options) {
        select.append(new Option(option.label, option.id, false, filled(option.value)));
      }
    } else {
      select.append(
        new Option('Yes', 'true', false, field.default === true),
        new Option('No', 'false', false, field.default === false),
      );
    }
    select.required = !field.optional;
    return [select, () => select.value || undefined];
  }
  const input = element('input');
  input.placeholder = field.placeholder;
  if (field.type === 'bool') {
    input.type = 'checkbox';
    input.checked = field.default === true;
    return [input, () => input.checked];
  }
  input.required = !field.optional;
  if (field.type === 'number') {
    input.type = 'number';
    input.step = 'any';
  }
  // A list is typed as text, its items split on commas by the engine.
  if (Array.isArray(field.default)) input.value = field.default.join(', ');
  else if (field.default !== null && typeof field.default !== 'object')
    input.value = String(field.default);
  return [
    input,
    () =>
      input.value.trim() === ''
        ? undefined
        : field.type === 'number'
          ? Number(input.value)
          : input.value,
  ];
}

function showPrompt(prompt: Prompt): void {
  stage.replaceChildren(...notes(), element('h2', prompt.title));
  const form = element('form');
  const fields = prompt.fields.map((field) => {
    // The reader's words for it; `name` is what the answer is keyed by.
    const label = element('label', field.optional ? `${field.label} (optional)` : field.label);
    const [input, read] = control(field);
    label.append(input);
    form.append(label);
    return { field, input, read };
  });
  const submit = element('button', 'Continue');
  submit.className = 'primary';
  form.append(submit);
  form.onsubmit = (event) => {
    event.preventDefault();
    const values: Record<string, RippleValue> = {};
    for (const { field, input, read } of fields) {
      const value = read();
      // A required field is not submitted empty; an optional one is left out.
      if (value === undefined && !field.optional) {
        const first = input.querySelector('input') ?? input;
        if (first instanceof HTMLInputElement || first instanceof HTMLSelectElement) {
          first.setCustomValidity('Please answer this one.');
          first.reportValidity();
          first.addEventListener('input', () => first.setCustomValidity(''), { once: true });
        }
        return;
      }
      if (value !== undefined) values[field.name] = value;
    }
    player?.answer(values);
  };
  stage.append(form);
}

const ASKS: Record<PermissionKind, [question: string, standIn: string]> = {
  dateTime: ['This story would like to know the date and time.', 'or a time, 2026-10-31 23:00'],
  location: ['This story would like to know where you are.', 'or a place, Rome or 41.9, 12.5'],
};

// The question before the story begins, a kind at a time. A reader who says
// no may say what the story should believe instead.
function showPermit(kinds: readonly PermissionKind[]): void {
  stage.replaceChildren(...notes(), element('h2', 'Before the story begins'));
  for (const kind of kinds) {
    const [question, hint] = ASKS[kind];
    const row = element('div');
    row.className = 'permit';
    const standIn = element('input');
    standIn.placeholder = hint;
    standIn.setAttribute('aria-label', `What the story should believe instead`);
    const answered = (granted: boolean) => {
      row.remove();
      player?.permit(kind, granted);
    };
    row.append(
      element('p', question),
      button('Allow', () => {
        // A fix is handed over before the yes that begins the story, or its
        // first page reads nothing.
        if (kind !== 'location' || !navigator.geolocation) return answered(true);
        navigator.geolocation.getCurrentPosition(
          (fix) => {
            player?.setPosition({
              latitude: fix.coords.latitude,
              longitude: fix.coords.longitude,
              accuracy: fix.coords.accuracy,
              when: momentOf(new Date(fix.timestamp)),
            });
            answered(true);
          },
          () => answered(true),
          { timeout: 10_000 },
        );
      }),
      button("Don't allow", () => {
        try {
          player?.setStandIn(kind, standIn.value.trim() || undefined);
        } catch (error) {
          standIn.setCustomValidity((error as Error).message);
          standIn.reportValidity();
          return;
        }
        answered(false);
      }),
      standIn,
    );
    stage.append(row);
  }
}

function onCountdown(countdown: Countdown | undefined): void {
  counting =
    countdown?.begun && countdown.timer.visible
      ? { ends: performance.now() + countdown.timer.timeoutMs, ms: countdown.timer.timeoutMs }
      : undefined;
  drawCountdown();
}

function drawCountdown(): void {
  stage.querySelector('.countdown')?.remove();
  if (!counting) return;
  const left = Math.max(0, counting.ends - performance.now());
  const bar = element('div');
  bar.className = 'hold countdown';
  const fill = element('div');
  bar.append(fill);
  const choices = stage.querySelector('.choices');
  if (choices) choices.before(bar);
  else stage.append(bar);
  fill.animate([{ width: `${(100 * left) / counting.ms}%` }, { width: '0%' }], {
    duration: left,
    fill: 'forwards',
  });
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
    case 'permit':
      showPermit(effect.kinds);
      break;
    case 'notice':
      notices.push(effect.notice.message);
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
  notices.length = 0;
  player = new Player(campaign.session({ seed: BigInt(Date.now()), locale }), {
    onEffect,
    onCountdown,
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
