/**
 * Font loading utilities.
 *
 * Web fonts loaded via @font-face and Google Fonts CSS need a moment
 * before they're available for rendering. This module provides helpers
 * to wait for font readiness.
 *
 * @see Issue #30
 */

/** Font family names as used in CSS fontFamily strings. */
export const FontFamilies = {
  /** Kenney Bold — loaded via @font-face in index.html */
  kenneyBold: '"Kenney Bold"',
  /** Caveat — Google Font loaded via CSS link in index.html */
  caveat: 'Caveat',
  /** Monospace fallback */
  mono: '"Courier New"',
} as const;

/**
 * Wait for a specific font to be loaded and ready for rendering.
 * Uses the Font Loading API (document.fonts).
 *
 * @param fontFamily - CSS font-family string (e.g. '"Kenney Bold"')
 * @param timeout - Max time to wait in ms (default 3000)
 * @returns true if font loaded, false if timed out
 */
export async function waitForFont(fontFamily: string, timeout = 3000): Promise<boolean> {
  if (!document?.fonts) {
    // Font Loading API not available (e.g. SSR) — assume loaded
    return true;
  }

  try {
    const loaded = await Promise.race([
      document.fonts.load(`16px ${fontFamily}`),
      new Promise<FontFace[]>((_, reject) =>
        setTimeout(() => reject(new Error('Font load timeout')), timeout),
      ),
    ]);
    return loaded.length > 0;
  } catch {
    return false;
  }
}

/**
 * Wait for all project fonts to be loaded.
 * Call this during scene preload to ensure fonts are available.
 *
 * @returns Map of font family → loaded (true/false)
 */
export async function waitForAllFonts(timeout = 3000): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  const families = Object.values(FontFamilies);

  await Promise.all(
    families.map(async (family) => {
      results[family] = await waitForFont(family, timeout);
    }),
  );

  return results;
}
