import type { Vec2 } from './Vec2.js';

export function buildSectorPolygon(
  cx: number,
  cy: number,
  facing: number,
  arcAngle: number,
  innerRadius: number,
  outerRadius: number,
): Vec2[] {
  if (arcAngle === 0) {
    return [
      { x: cx + innerRadius * Math.cos(facing), y: cy + innerRadius * Math.sin(facing) },
      { x: cx + outerRadius * Math.cos(facing), y: cy + outerRadius * Math.sin(facing) },
    ];
  }

  const half = arcAngle / 2;
  const quarter = arcAngle / 4;

  return [
    {
      x: cx + innerRadius * Math.cos(facing - half),
      y: cy + innerRadius * Math.sin(facing - half),
    },
    {
      x: cx + outerRadius * Math.cos(facing - half),
      y: cy + outerRadius * Math.sin(facing - half),
    },
    {
      x: cx + outerRadius * Math.cos(facing - quarter),
      y: cy + outerRadius * Math.sin(facing - quarter),
    },
    { x: cx + outerRadius * Math.cos(facing), y: cy + outerRadius * Math.sin(facing) },
    {
      x: cx + outerRadius * Math.cos(facing + quarter),
      y: cy + outerRadius * Math.sin(facing + quarter),
    },
    {
      x: cx + outerRadius * Math.cos(facing + half),
      y: cy + outerRadius * Math.sin(facing + half),
    },
    {
      x: cx + innerRadius * Math.cos(facing + half),
      y: cy + innerRadius * Math.sin(facing + half),
    },
  ];
}

export function buildRotatedRect(
  cx: number,
  cy: number,
  facing: number,
  width: number,
  length: number,
  startOffset: number,
): Vec2[] {
  const fwdX = Math.cos(facing);
  const fwdY = Math.sin(facing);
  const perpX = -fwdY;
  const perpY = fwdX;
  const hw = width / 2;
  const far = startOffset + length;

  return [
    { x: cx + startOffset * fwdX + hw * perpX, y: cy + startOffset * fwdY + hw * perpY },
    { x: cx + far * fwdX + hw * perpX, y: cy + far * fwdY + hw * perpY },
    { x: cx + far * fwdX - hw * perpX, y: cy + far * fwdY - hw * perpY },
    { x: cx + startOffset * fwdX - hw * perpX, y: cy + startOffset * fwdY - hw * perpY },
  ];
}
