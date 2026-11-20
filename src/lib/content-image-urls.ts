import type { ImageMetadata } from 'astro';
import { rewriteImagePaths } from './markdown-images.mjs';

/**
 * Where the build serves each image under `src/assets/`.
 *
 * Vite gives every imported image a hashed file under `/_astro/` and the import
 * resolves to its metadata, `src` included. This glob is that import for every
 * image a content entry can reference, so a route that emits a body as markdown
 * can turn `../../assets/file.png` into the address of the same file. It is the
 * original file, not the optimised `.webp` the HTML page uses: `getImage()` in an
 * on-demand route answers with the image endpoint, not a built file.
 *
 * Eager, because the two `.md` routes run per request and the map is a few
 * strings. Server-side only: no page imports this module.
 */
const modules = import.meta.glob<ImageMetadata>(
  '../assets/**/*.{png,jpg,jpeg,gif,webp,avif,svg}',
  { eager: true, import: 'default' }
);

const builtPaths = new Map<string, string>(
  Object.entries(modules).map(([key, image]) => [key.replace(/^\.\.\//, 'src/'), image.src])
);

/** The built path (`/_astro/...`) of a repo-relative source path, if it is an image under `src/assets/`. */
export function contentImagePath(sourcePath: string): string | undefined {
  return builtPaths.get(sourcePath);
}

type Unresolved = 'throw' | 'keep';

/**
 * A content body with its relative image targets made absolute.
 *
 * `unresolved` says what a target with no built address does. A prerendered route
 * passes `'throw'`, so the build fails and names the entry. An on-demand route
 * passes `'keep'`: every published body has already been through the prerendered
 * `llms-full.txt`, so only a draft under `SHOW_DRAFTS` can reach it, and a 500 for
 * the whole document is worse than one image left as written and a log line.
 */
export function withPublicImages(
  body: string,
  entry: { filePath?: string },
  origin: string,
  unresolved: Unresolved
): string {
  return rewriteImagePaths(body, {
    filePath: entry.filePath,
    lookup: contentImagePath,
    origin,
    onUnresolved:
      unresolved === 'throw'
        ? undefined
        : ({ target, line, filePath }) =>
            console.warn(
              `markdown-images: ${filePath ?? 'entry'} body line ${line}: image ${JSON.stringify(target)} has no built address; left as written`
            ),
  });
}
