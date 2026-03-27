// src/narrativeBuffer.ts
import { BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage } from "@langchain/core/messages";
import { GeminiPluginSettings } from './settings';

/**
 * NarrativeBufferクラス
 * 会話履歴を「ワーキングメモリ（直近Nターン）」と「ナラティブ要約（それ以前）」に分離して管理する。
 * 古いターンは小モデルでインクリメンタルに要約され、ナラティブバッファに蓄積される。
 */
export class NarrativeBuffer {
  private narrativeSummary: string = '';
  private workingMemorySize: number;
  private summarizationLlm: ChatGoogleGenerativeAI | null = null;
  private settings: GeminiPluginSettings;
  private lastSummarizedMessageCount: number = 0;

  constructor(settings: GeminiPluginSettings, workingMemorySize: number = 3) {
    this.settings = settings;
    this.workingMemorySize = workingMemorySize;
    this.initializeLlm();
  }

  private initializeLlm(): void {
    if (!this.settings.geminiApiKey) {
      this.summarizationLlm = null;
      return;
    }
    const modelName = this.settings.keywordExtractionModel || this.settings.geminiModel;
    if (modelName) {
      try {
        this.summarizationLlm = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: modelName,
        });
      } catch (e: any) {
        console.error("[NarrativeBuffer] Failed to initialize summarization LLM:", e.message);
        this.summarizationLlm = null;
      }
    }
  }

  public onSettingsChanged(newSettings: GeminiPluginSettings): void {
    this.settings = newSettings;
    this.initializeLlm();
  }

  /**
   * 会話履歴が更新された時に呼び出される。
   * ワーキングメモリ範囲外に押し出されたターンがあれば、要約を更新する。
   * @param allMessages 全会話履歴
   */
  public async onMessagesUpdated(allMessages: BaseMessage[]): Promise<void> {
    // ワーキングメモリサイズ × 2（user+ai で1ターン）を超えた分を要約対象にする
    const workingMemoryMessageCount = this.workingMemorySize * 2;
    const totalMessages = allMessages.length;

    if (totalMessages <= workingMemoryMessageCount) {
      // まだワーキングメモリに収まっている
      return;
    }

    // 要約対象: ワーキングメモリより前のメッセージ
    const messagesToSummarize = allMessages.slice(0, totalMessages - workingMemoryMessageCount);

    // 前回要約した時と同じメッセージ数なら、再要約不要
    if (messagesToSummarize.length <= this.lastSummarizedMessageCount) {
      return;
    }

    // 新しく古くなったターンだけを抽出
    const newlyAgedMessages = messagesToSummarize.slice(this.lastSummarizedMessageCount);

    if (newlyAgedMessages.length === 0) {
      return;
    }

    await this.updateNarrativeSummary(newlyAgedMessages);
    this.lastSummarizedMessageCount = messagesToSummarize.length;
  }

  /**
   * ナラティブ要約をインクリメンタルに更新する。
   * 「前回の要約 + 新しく古くなったターン」→「新しい要約」
   */
  private async updateNarrativeSummary(newMessages: BaseMessage[]): Promise<void> {
    if (!this.summarizationLlm) {
      console.warn("[NarrativeBuffer] Summarization LLM not available. Skipping summary update.");
      return;
    }

    const newConversationText = newMessages.map(msg => {
      const role = msg._getType() === "human" ? "User" : "Assistant";
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
      const response = await this.summarizationLlm.invoke([new HumanMessage(prompt)]);
      const summaryText = response.content as string;
      if (summaryText && summaryText.trim()) {
        this.narrativeSummary = summaryText.trim();
        console.log("[NarrativeBuffer] Narrative summary updated:", this.narrativeSummary.substring(0, 100) + "...");
      }
    } catch (e: any) {
      console.error("[NarrativeBuffer] Error updating narrative summary:", e.message);
    }
  }

  /**
   * 現在のナラティブ要約を取得する。
   */
  public getNarrativeSummary(): string {
    return this.narrativeSummary;
  }

  /**
   * ワーキングメモリ（直近Nターン分のメッセージ）を取得する。
   * @param allMessages 全会話履歴
   * @returns ワーキングメモリに含まれるメッセージ配列
   */
  public getWorkingMemoryMessages(allMessages: BaseMessage[]): BaseMessage[] {
    const workingMemoryMessageCount = this.workingMemorySize * 2;
    if (allMessages.length <= workingMemoryMessageCount) {
      return allMessages;
    }
    return allMessages.slice(-workingMemoryMessageCount);
  }

  /**
   * チャットリセット時に呼び出す。ナラティブバッファの状態をクリアする。
   */
  public reset(): void {
    this.narrativeSummary = '';
    this.lastSummarizedMessageCount = 0;
  }
}
