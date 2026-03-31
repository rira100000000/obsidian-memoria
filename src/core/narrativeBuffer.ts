// src/narrativeBuffer.ts
import { LLMAdapter } from './interfaces/llmAdapter';
import { GeminiLLMAdapter } from '../adapters/geminiLLMAdapter';
import { MemoriaMessage } from './types';

/**
 * NarrativeBufferクラス
 * 会話履歴を「ワーキングメモリ（直近Nターン）」と「ナラティブ要約（それ以前）」に分離して管理する。
 * 古いターンは小モデルでインクリメンタルに要約され、ナラティブバッファに蓄積される。
 */
export class NarrativeBuffer {
  private narrativeSummary: string = '';
  private workingMemorySize: number;
  private llm: LLMAdapter;
  private lastSummarizedMessageCount: number = 0;
  private isSummarizing: boolean = false;

  constructor(llm: LLMAdapter, workingMemorySize: number = 3) {
    this.llm = llm;
    this.workingMemorySize = workingMemorySize;
  }

  /**
   * 会話履歴が更新された時に呼び出される。
   * ワーキングメモリ範囲外に押し出されたターンがあれば、要約を更新する。
   */
  public async onMessagesUpdated(allMessages: MemoriaMessage[]): Promise<void> {
    if (this.isSummarizing) return;

    const workingMemoryMessageCount = this.workingMemorySize * 2;
    const totalMessages = allMessages.length;

    if (totalMessages <= workingMemoryMessageCount) {
      return;
    }

    const messagesToSummarize = allMessages.slice(0, totalMessages - workingMemoryMessageCount);

    if (messagesToSummarize.length <= this.lastSummarizedMessageCount) {
      return;
    }

    const newlyAgedMessages = messagesToSummarize.slice(this.lastSummarizedMessageCount);

    if (newlyAgedMessages.length === 0) {
      return;
    }

    this.isSummarizing = true;
    try {
      await this.updateNarrativeSummary(newlyAgedMessages);
      this.lastSummarizedMessageCount = messagesToSummarize.length;
    } finally {
      this.isSummarizing = false;
    }
  }

  private async updateNarrativeSummary(newMessages: MemoriaMessage[]): Promise<void> {
    if (!this.llm.isAvailable()) {
      console.warn("[NarrativeBuffer] Summarization LLM not available. Skipping summary update.");
      return;
    }

    const newConversationText = newMessages.map(msg => {
      const role = msg.role === "human" ? "User" : "Assistant";
      return `${role}: ${msg.content}`;
    }).join('\n');

    const prompt = this.narrativeSummary
      ? `以下は会話AIと人間の対話の要約タスクです。

これまでの会話の要約:
${this.narrativeSummary}

新しく追加された会話部分:
${newConversationText}

上記の「これまでの要約」と「新しい会話部分」を統合して、会話全体の新しい要約を作成してください。
- 重要な事実、決定事項、ユーザーの好みや意見を必ず保持すること
- 不要な詳細は省略し、簡潔にまとめること
- 時系列の流れが分かるようにすること
- 200文字以内を目安にすること`
      : `以下は会話AIと人間の対話の要約タスクです。

会話内容:
${newConversationText}

上記の会話内容を簡潔に要約してください。
- 重要な事実、決定事項、ユーザーの好みや意見を中心にまとめること
- 不要な詳細は省略すること
- 200文字以内を目安にすること`;

    try {
      if (this.llm instanceof GeminiLLMAdapter) {
        (this.llm as GeminiLLMAdapter).setNextCallLabel('NarrativeBuffer (会話要約)');
      }
      const summaryText = await this.llm.generate(prompt, { tier: 'light' });
      if (summaryText && summaryText.trim()) {
        this.narrativeSummary = summaryText.trim();
        console.log("[NarrativeBuffer] Narrative summary updated:", this.narrativeSummary.substring(0, 100) + "...");
      }
    } catch (e: any) {
      console.error("[NarrativeBuffer] Error updating narrative summary:", e.message);
    }
  }

  public getNarrativeSummary(): string {
    return this.narrativeSummary;
  }

  public getWorkingMemoryMessages(allMessages: MemoriaMessage[]): MemoriaMessage[] {
    const workingMemoryMessageCount = this.workingMemorySize * 2;
    if (allMessages.length <= workingMemoryMessageCount) {
      return allMessages;
    }
    return allMessages.slice(-workingMemoryMessageCount);
  }

  public reset(): void {
    this.narrativeSummary = '';
    this.lastSummarizedMessageCount = 0;
  }
}
