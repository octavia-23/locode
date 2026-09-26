import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  clean: true,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node'
  }
});
