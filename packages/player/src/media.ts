// A bundle path as a URL path. Media paths are the author's own folder and
// file names — spaces, accents, `#` and `?` included — so each segment is
// encoded on its own and the `/` between them never is: an encoded slash would
// name a different file (`integrating-a-host.md` §12).
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
