/** Canonical 2D vector / point. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Minimum translation vector for collision resolution. */
export interface MTV {
  x: number;
  y: number;
  depth: number;
}

/** Circular area. */
export interface Circle {
  x: number;
  y: number;
  radius: number;
}
