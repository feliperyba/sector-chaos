import type { DomainEvent } from './DomainEvent.ts';
import { MatchPhase } from '@sector-battle/shared';

export interface MatchPhaseChangedEvent extends DomainEvent {
  type: 'MatchPhaseChanged';
  from: MatchPhase;
  to: MatchPhase;
}
