// Bundles the Worker. Files under src/client/ are imported as plain text.
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

const textClient = {
  name: 'client-as-text',
  setup(b) {
    b.onLoad({ filter: /[\\/]client[\\/].+\.(js|css|html)$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      const ext = args.path.split('.').pop();
      const contents = ext === 'html' ? src : (await transform(src, { loader: ext, minify: true, target: ext === 'js' ? 'es2020' : undefined })).code;
      return { contents, loader: 'text' };
    });
  },
};

await build({
  entryPoints: ['src/worker.js'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minifySyntax: true,
  minifyWhitespace: true,
  outfile: process.argv[2] || 'dist/worker.js',
  plugins: [textClient],
  logLevel: 'warning',
});
