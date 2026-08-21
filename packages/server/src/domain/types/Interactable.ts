import { Position } from '../value-objects/index.ts';

export interface Interactable {
  id: string;
  position: Position;
  type: 'chest' | 'weapon_pickup';
}
