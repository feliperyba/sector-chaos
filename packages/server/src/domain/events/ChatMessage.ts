import type { DomainEvent } from './DomainEvent.ts';

export interface ChatMessageEvent extends DomainEvent {
  type: 'ChatMessage';
  senderId: string;
  text: string;
}
