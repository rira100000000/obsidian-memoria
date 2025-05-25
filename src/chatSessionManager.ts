// src/chatSessionManager.ts
import { App, Notice, TFile } from 'obsidian';
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatUIManager, ConfirmationModal } from './ui/chatUIManager';
import { ChatLogger } from './chatLogger';
import { TagProfiler } from './tagProfiler';
import ObsidianMemoria from './../main';
// import { ConversationReflectionTool } from './tools/conversationReflectionTool'; // ToolManager経由で利用

export class ChatSessionManager {
  private app: App;
  private plugin: ObsidianMemoria;
  public messageHistory: ChatMessageHistory;
  private uiManager: ChatUIManager;
  private chatLogger: ChatLogger;
  private tagProfiler: TagProfiler;
  private llmRoleName: string;
  private managerInstanceId: string;

  constructor(
    app: App,
    plugin: ObsidianMemoria,
    uiManager: ChatUIManager,
    chatLogger: ChatLogger,
    tagProfiler: TagProfiler,
    initialLlmRoleName: string
  ) {
    this.app = app;
    this.plugin = plugin;
    this.uiManager = uiManager;
    this.chatLogger = chatLogger;
    this.tagProfiler = tagProfiler;
    this.llmRoleName = initialLlmRoleName;
    this.messageHistory = new ChatMessageHistory();
    this.managerInstanceId = Math.random().toString(36).substring(2, 8);
    console.log(`[ChatSessionManager][${this.managerInstanceId}] New instance created. Initial RoleName: ${initialLlmRoleName}. Using ChatLogger ID: ${(this.chatLogger as any).instanceId}`);
  }

  public updateLlmRoleName(newRoleName: string): void {
    const oldRoleName = this.llmRoleName;
    this.llmRoleName = newRoleName;
    console.log(`[ChatSessionManager][${this.managerInstanceId}] llmRoleName updated from '${oldRoleName}' to '${this.llmRoleName}'`);
    // ToolManagerやTagProfilerのonSettingsChangedはChatViewから呼び出される想定
  }

  public updateChatLogger(newChatLogger: ChatLogger): void {
    const oldLoggerId = this.chatLogger ? (this.chatLogger as any).instanceId : 'N/A';
    this.chatLogger = newChatLogger;
    console.log(`[ChatSessionManager][${this.managerInstanceId}] ChatLogger instance updated. Old ID: ${oldLoggerId}, New ID: ${(this.chatLogger as any).instanceId}`);
  }

  /**
   * チャットセッションをリセットします。
   * @param skipAutomaticReflection trueの場合、セッション終了時の自動的な振り返り処理をスキップします（LLMによるツール呼び出しは別途）。
   */
  public async resetChat(skipAutomaticReflection = true): Promise<void> {
    const previousLogPath = this.chatLogger.getLogFilePath();
    // const previousLlmRoleName = this.llmRoleName; // LLMロール名は現在のものを使用
    const previousMessages = await this.messageHistory.getMessages();
    const currentChatLoggerId = this.chatLogger ? (this.chatLogger as any).instanceId : 'N/A';

    console.log(`[ChatSessionManager][${this.managerInstanceId}] Initiating resetChat. SkipAutomaticReflection: ${skipAutomaticReflection}, LogPath: '${previousLogPath}', MessagesCount: ${previousMessages.length}, Using ChatLogger ID: ${currentChatLoggerId}`);

    if (!skipAutomaticReflection && previousLogPath && previousMessages.length > 1) {
      console.log(`[ChatSessionManager][${this.managerInstanceId}] Previous session had ${previousMessages.length} messages. Log file at ${previousLogPath} will be finalized if not already handled by reflection tool.`);
      // 以前はここでreflectionToolを直接呼び出していたが、Tool CallingモデルではLLMの判断に委ねる。
      // 必要であれば、ログファイルのフロントマターに「会話終了」などのステータスを追記する。
      try {
        const logFile = this.app.vault.getAbstractFileByPath(previousLogPath);
        if (logFile instanceof TFile) {
            await this.app.fileManager.processFrontMatter(logFile, (fm) => {
                if (!fm.summary_note) { // まだサマリーノートがリンクされていなければ
                    fm.title = fm.title ? `(Ended) ${fm.title}` : `(Ended) Chat Log ${previousLogPath.split('/').pop()?.replace('.md','')}`;
                    fm.status = "ended_without_reflection_tool_call"; // 例: ステータス追加
                }
            });
            new Notice(`以前のチャットセッションのログ (${previousLogPath.split('/').pop()}) は保存されました。`);
        }
      } catch (e) {
        console.error(`[ChatSessionManager][${this.managerInstanceId}] Error finalizing frontmatter for previous log ${previousLogPath}:`, e);
      }
    } else if (previousLogPath && previousMessages.length <=1 && !skipAutomaticReflection) {
        console.log(`[ChatSessionManager][${this.managerInstanceId}] Short conversation, no automatic reflection needed for log: ${previousLogPath}`);
    }


    // 新しいチャットセッションの準備
    this.chatLogger.resetLogFile(); // これにより currentLogFilePath が null になる
    // 新しいログファイルは、次のメッセージ送信時に ChatView の sendMessage 内で setupLogFile によって作成される
    this.messageHistory = new ChatMessageHistory();

    this.uiManager.clearMessages();
    this.uiManager.appendModelMessage(`チャットウィンドウへようこそ！ ${this.llmRoleName}がお話しします。\nShift+Enterでメッセージを送信します。`);
    this.uiManager.resetInputField();
    this.uiManager.scrollToBottom();

    console.log(`[ChatSessionManager][${this.managerInstanceId}] Chat has been reset. New log file will be created on next message.`);
    new Notice('新しいチャットが開始されました。');
  }

  public async confirmAndDiscardChat(): Promise<void> {
    const messages = await this.messageHistory.getMessages();
    const currentLogPath = this.chatLogger.getLogFilePath();

    if (!currentLogPath && messages.length <= 1) { // ログファイルがなく、メッセージもほとんどない場合
        new Notice('破棄するチャットログが実質的にありません。');
        await this.resetChat(true); // UIリセットのために呼ぶ
        // new Notice('現在のチャット（ログなし）が破棄され、新しいチャットが開始されました。'); // resetChat内で通知
        return;
    }

    const modal = new ConfirmationModal(
        this.app,
        'チャット履歴の破棄',
        '現在のチャット履歴と関連ログファイルを完全に破棄しますか？この操作は元に戻せません。振り返りノートも生成されません。',
        async () => {
            await this.discardCurrentChatLogAndReset();
        }
    );
    modal.open();
  }

  private async discardCurrentChatLogAndReset(): Promise<void> {
    const currentLogPath = this.chatLogger.getLogFilePath();
    if (currentLogPath) {
        await this.chatLogger.deleteLogFile(currentLogPath); // ログファイル削除
    } else {
        console.log(`[ChatSessionManager][${this.managerInstanceId}] No log file path set to delete during discard.`);
    }
    // resetChatを呼び出してメッセージ履歴とUIをクリア
    // true を渡して、この破棄操作では追加の振り返り処理を試みないようにする
    await this.resetChat(true);
    // new Notice('現在のチャットが破棄され、新しいチャットが開始されました。'); // resetChat内で通知
  }

  public async getMessages(): Promise<BaseMessage[]> {
    return this.messageHistory.getMessages();
  }

  public async addMessage(message: BaseMessage): Promise<void> {
    await this.messageHistory.addMessage(message);
  }

  public async addUserMessage(textContent: string): Promise<void> {
    await this.messageHistory.addMessage(new HumanMessage(textContent));
  }

  public async addAiMessage(textContent: string): Promise<void> {
    await this.messageHistory.addMessage(new AIMessage(textContent));
  }
}
