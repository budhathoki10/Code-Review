/** Formats without a useful text diff. SVG is text and must remain reviewable. */
export function isBinaryPath(filename: string): boolean {
  return /\.(png|jpe?g|gif|bmp|ico|webp|avif|pdf|woff2?|ttf|eot|otf|mp4|mov|avi|webm|mp3|wav|zip|tar|gz|bz2|xz|7z|rar|jar|so|dll|dylib|wasm|exe|bin|class|pyc|db|sqlite3?)$/i.test(filename);
}
