// src/utils/messageConverter.ts
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { MemoriaMessage } from '../core/types';

export function toLangChain(messages: MemoriaMessage[]): BaseMessage[] {
  return messages.map(m => {
    switch (m.role) {
      case 'human': return new HumanMessage(m.content);
      case 'ai': return new AIMessage(m.content);
      case 'system': return new SystemMessage(m.content);
      default: return new HumanMessage(m.content);
    }
  });
}

export function fromLangChain(messages: BaseMessage[]): MemoriaMessage[] {
  return messages.map(m => ({
    role: (m._getType() === 'human' ? 'human' : m._getType() === 'ai' ? 'ai' : 'system') as MemoriaMessage['role'],
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
}
