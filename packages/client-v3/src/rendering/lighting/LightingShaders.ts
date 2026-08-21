/**
 * Loads the lighting shader sources from the `.frag` files in this directory.
 *
 * Uses Vite's `?raw` import to inline the GLSL as strings at build time, so:
 *   - the GameObjects.Shader `fragmentSource` config gets the source directly
 *     (no `load.glsl` cache dependency), and
 *   - the FilterFinal render node gets the source for its constructor.
 *
 * The `.frag` files are the single source of truth for the GLSL — they're
 * real files under `src/shaders/lighting/`, edited directly (mirroring the
 * `shaders/transition.frag` precedent). The `*?raw` suffix is typed by
 * `vite/client` (referenced from `src/vite-env.d.ts`).
 *
 * The bloom chain (ticket 08) adds two more sources: the Bright-pass extractor
 * (`bright.frag`) and the separable Gaussian blur (`blur.frag`, shared by the
 * H + V stages via the `uDir` uniform). Both are verbatim ports of the
 * validated 06 prototype's BRIGHT_FRAG + BLUR_FRAG.
 */
import sobelFrag from '../../shaders/lighting/sobel.frag?raw';
import hdrLitFrag from '../../shaders/lighting/hdrLit.frag?raw';
import finalFrag from '../../shaders/lighting/final.frag?raw';
import brightFrag from '../../shaders/lighting/bright.frag?raw';
import blurFrag from '../../shaders/lighting/blur.frag?raw';

export const SOBEL_FRAG_SOURCE: string = sobelFrag;
export const HDR_LIT_FRAG_SOURCE: string = hdrLitFrag;
export const FINAL_FRAG_SOURCE: string = finalFrag;
export const BRIGHT_FRAG_SOURCE: string = brightFrag;
export const BLUR_FRAG_SOURCE: string = blurFrag;
