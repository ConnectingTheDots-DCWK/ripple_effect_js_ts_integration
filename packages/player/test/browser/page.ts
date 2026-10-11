// The page the browser pass opens: the package as a bundler builds it, and
// one function the runner calls per fixture. It loads the fixture's bundle
// over HTTP with `Campaign.load` — the path a real page takes — and plays it
// through the same driver as the Node suite, answering the canonical trace
// for Node to compare. Holds are not waited on: the session host settles
// them, as a fixture's clock asks.
import { Campaign } from '../../src/index.ts';
import { canonical, type Input, play } from '../driver.ts';

declare global {
  interface Window {
    play(
      name: string,
      input: string,
      python: boolean,
    ): Promise<{ trace: string[]; entities: string; callbacks: string[]; variant: string }>;
    ready: boolean;
  }
}

// Ints cross from Node as {"$int": "7"}, because a browser's JSON.parse
// cannot be relied on to say whether a number was written with a point.
function revive(text: string): Input {
  return JSON.parse(text, (_key, value) =>
    value && typeof value === 'object' && typeof value.$int === 'string'
      ? BigInt(value.$int)
      : value,
  ) as Input;
}

window.play = async (name, input, python) => {
  const campaign = await Campaign.load(`/fixtures/${name}/bundle/`, { python });
  const fixture = revive(input);
  const got = play(campaign, fixture, 'session');
  return {
    trace: got.trace.map(canonical),
    entities: canonical(got.entities),
    callbacks: got.callbacks.map(canonical),
    variant: campaign.variant,
  };
};
window.ready = true;
