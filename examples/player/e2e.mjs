import { chromium, firefox, webkit } from 'playwright';

const which = { chromium, firefox, webkit }[process.argv[2] ?? 'chromium'];
const b = await which.launch(
  process.argv[2] === 'firefox' ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } } : {},
);
const p = await b.newPage();
const errors = [];
const requests = [];
p.on('request', (r) => {
  if (/\.(mp3|ogg|wav)/.test(r.url())) requests.push(decodeURIComponent(r.url().split('/').pop()));
});
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await p.goto('http://localhost:5179/');
await p.waitForSelector('button.primary', { timeout: 30000 });
const cover = await p.$eval('img.cover', (i) => i.naturalWidth).catch(() => 0);
await p.click('button.primary');
const log = [];
for (let step = 0; step < 40; step++) {
  await p.waitForTimeout(3000);
  const state = await p.evaluate(() => ({
    h: document.querySelector('main h1, main h2')?.textContent ?? null,
    text: document.querySelector('.prose')?.textContent?.slice(0, 50) ?? null,
    imgs: [...document.querySelectorAll('.prose img')].map((i) => [
      i.getAttribute('src'),
      i.naturalWidth,
    ]),
    choices: [...document.querySelectorAll('.choices button')].map((b) => b.textContent),
    playing: [...document.querySelectorAll('audio')].length,
  }));
  const media = await p.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((e) => /\.mp3/.test(e.name))
      .map((e) => decodeURIComponent(e.name.split('/').pop())),
  );
  log.push(
    `${step} ${state.h ?? ''} | ${state.text ?? ''} | imgs ${JSON.stringify(state.imgs)} | choices ${state.choices.length} | mp3 ${[...new Set(media)].join(',')}`,
  );
  if (step === 5)
    log.push(
      '   sounding: ' +
        JSON.stringify(
          await p.evaluate(() => ({
            playing: window.ripple.audio.playing,
            idle: window.ripple.audio.idle,
            state: window.ripple.speaker.context.state,
          })),
        ),
    );
  if (!state.choices.length) break;
  await p.click('.choices button:not(:disabled)');
}
console.log(`cover ${cover}`);
console.log(log.join('\n'));
console.log('audio requests', JSON.stringify([...new Set(requests)]));
console.log(
  'ctx',
  JSON.stringify(
    await p.evaluate(() => ({
      state: window.ripple.speaker.context.state,
      time: window.ripple.speaker.context.currentTime,
    })),
  ),
);
console.log('errors', JSON.stringify(errors));
await b.close();
