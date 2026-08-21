import type { GameEvent } from '../events/index.ts';
import { EventCollector } from '../shared/EventCollector.ts';

export interface SiegeConfig {
  sectorGridSize: number;
  sectorTileSize: number;
  tilePixelSize: number;
}

export interface SiegedSector {
  row: number;
  col: number;
}

export class SiegeService {
  private readonly sectorPixelSize = this.config.sectorTileSize * this.config.tilePixelSize;
  private siegedSectors: Map<string, SiegedSector> = new Map();
  private eventCollector = new EventCollector<GameEvent>();

  constructor(private readonly config: SiegeConfig) {}

  checkSiegeStatus(zoneCenter: { x: number; y: number }, zoneRadius: number): GameEvent[] {
    for (let row = 0; row < this.config.sectorGridSize; row++) {
      for (let col = 0; col < this.config.sectorGridSize; col++) {
        const key = `${row},${col}`;
        if (this.siegedSectors.has(key)) continue;

        const centerX = (col + 0.5) * this.sectorPixelSize;
        const centerY = (row + 0.5) * this.sectorPixelSize;

        const dx = centerX - zoneCenter.x;
        const dy = centerY - zoneCenter.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > zoneRadius) {
          this.siegedSectors.set(key, { row, col });
          this.eventCollector.emit({
            type: 'SectorSiegeStarted',
            tick: 0,
            timestamp: Date.now(),
            sectorRow: row,
            sectorCol: col,
          });
        }
      }
    }
    return this.drainEvents();
  }

  getSiegedSectors(): SiegedSector[] {
    return Array.from(this.siegedSectors.values());
  }

  isSectorSieged(row: number, col: number): boolean {
    return this.siegedSectors.has(`${row},${col}`);
  }

  drainEvents(): GameEvent[] {
    return this.eventCollector.drain();
  }
}
