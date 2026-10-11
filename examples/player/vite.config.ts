// The example serves a folder of compiled campaigns beside the page, each at
// /<its folder name>/, as the demo site will:
//
//   RIPPLE_CAMPAIGNS=<a folder of bundles> pnpm --filter @ripplefx/example-player dev
//
// A bundle is what the editor's Export → Campaign writes, or `compile` —
// `melos run campaign:compile` in the engine's repository leaves Elsenmar in
// build/campaign/. The folder is Vite's public directory, so every file is
// served as it is, with the range requests a media element needs to seek.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const campaigns = process.env.RIPPLE_CAMPAIGNS ? resolve(process.env.RIPPLE_CAMPAIGNS) : undefined;
if (!campaigns) {
  console.warn('example: RIPPLE_CAMPAIGNS is not set, so there is nothing to play.');
}

// `/campaigns.json`: the folders that hold a campaign.json, for the page to list.
const listing: Plugin = {
  name: 'ripple-campaigns',
  configureServer(server) {
    server.middlewares.use('/campaigns.json', (_request, response) => {
      const names = campaigns
        ? readdirSync(campaigns).filter((name) => {
            try {
              return statSync(join(campaigns, name, 'campaign.json')).isFile();
            } catch {
              return false;
            }
          })
        : [];
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(names.sort()));
    });
  },
};

export default defineConfig({
  publicDir: campaigns ?? false,
  plugins: [listing],
  server: { fs: { allow: ['../..'] } },
});
