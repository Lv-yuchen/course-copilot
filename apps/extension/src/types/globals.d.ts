/**
 * The global `chrome` binding.
 *
 * Kept in its own file, with no imports and no exports, so it contributes to the GLOBAL scope. A declaration file that has
 * exports is a module, and everything in it becomes module-scoped — which is why the extension API types in `chrome.d.ts`
 * are declared ambiently too. Both files being ambient is what lets the content script reference `RuntimeMessage` without an
 * `import`, and such an import is exactly what previously made the compiler emit `export {};` into a script the browser
 * loads as a classic script, where that keyword is a syntax error.
 */

declare const chrome: ChromeApi;
