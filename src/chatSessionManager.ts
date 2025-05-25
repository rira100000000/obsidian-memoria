// src/chatSessionManager.ts
import { App, Notice, TFile } from 'obsidian';
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { BaseMessage, HumanMessage, AIMessage }
from "@langchain/core/messages";
import { ChatUIManager, ConfirmationModal } from './ui/chatUIManager';
import { ChatLogger } from './chatLogger';
// import { SummaryGenerator } from './summaryGenerator'; // SummaryGenerator は不要になる
import { TagProfiler } from './tagProfiler';
import ObsidianMemoria from './../main';
import { ConversationReflectionTool } from './tools/conversationReflectionTool';

export class ChatSessionManager {
  private app: App;
  private plugin: ObsidianMemoria;
  public messageHistory: ChatMessageHistory;
  private uiManager: ChatUIManager;
  private chatLogger: ChatLogger; // このインスタンスが ChatView と同期している必要がある
  // private summaryGenerator: SummaryGenerator; // 不要になる
  private tagProfiler: TagProfiler;
  private llmRoleName: string;
  private reflectionTool: ConversationReflectionTool;
  private managerInstanceId: string; // デバッグ用のインスタンスID

  constructor(
    app: App,
    plugin: ObsidianMemoria,
    uiManager: ChatUIManager,
    chatLogger: ChatLogger, // 初期インスタンスを受け取る
    // summaryGenerator: SummaryGenerator, // 引数から削除
    tagProfiler: TagProfiler,
    initialLlmRoleName: string
  ) {
    this.app = app;
    this.plugin = plugin;
    this.uiManager = uiManager;
    this.chatLogger = chatLogger; // 受け取ったインスタンスを保存
    this.tagProfiler = tagProfiler;
    this.llmRoleName = initialLlmRoleName;
    this.messageHistory = new ChatMessageHistory();
    this.reflectionTool = new ConversationReflectionTool(this.plugin);
    this.managerInstanceId = Math.random().toString(36).substring(2, 8);
    console.log(`[ChatSessionManager][${this.managerInstanceId}] New instance created. Initial RoleName: ${initialLlmRoleName}. Using ChatLogger ID: ${(this.chatLogger as any).instanceId}`);
  }

  public updateLlmRoleName(newRoleName: string): void {
    const oldRoleName = this.llmRoleName;
    this.llmRoleName = newRoleName;
    console.log(`[ChatSessionManager][${this.managerInstanceId}] llmRoleName updated from '${oldRoleName}' to '${this.llmRoleName}'`);
    if (this.reflectionTool && typeof (this.reflectionTool as any).onSettingsChanged === 'function') {
        (this.reflectionTool as any).onSettingsChanged();
    }
    if (this.tagProfiler && typeof (this.tagProfiler as any).onSettingsChanged === 'function') {
        (this.tagProfiler as any).onSettingsChanged();
    }
  }

  /**
   * ChatView側でChatLoggerが再初期化された場合に、このメソッドを通じて
   * ChatSessionManagerが保持するChatLoggerインスタンスも更新します。
   * @param newChatLogger 新しいChatLoggerインスタンス
   */
  public updateChatLogger(newChatLogger: ChatLogger): void {
    const oldLoggerId = this.chatLogger ? (this.chatLogger as any).instanceId : 'N/A';
    this.chatLogger = newChatLogger;
    console.log(`[ChatSessionManager][${this.managerInstanceId}] ChatLogger instance updated. Old ID: ${oldLoggerId}, New ID: ${(this.chatLogger as any).instanceId}`);
  }

  public async resetChat(skipSummaryAndReflection = false): Promise<void> {
    // previousLogPath を取得する直前に、現在の ChatLogger の状態をログに出力
    const currentChatLoggerId = this.chatLogger ? (this.chatLogger as any).instanceId : 'N/A';
    console.log(`[ChatSessionManager][${this.managerInstanceId}] resetChat: Attempting to get log path from ChatLogger ID: ${currentChatLoggerId}`);
    const previousLogPath = this.chatLogger.getLogFilePath(); // ここで ChatLogger の getLogFilePath が呼ばれる
    const previousLlmRoleName = this.llmRoleName;
    const previousMessages = await this.messageHistory.getMessages();

    console.log(`[ChatSessionManager][${this.managerInstanceId}] Initiating reset. SkipReflection: ${skipSummaryAndReflection}, LogPath: '${previousLogPath}', MessagesCount: ${previousMessages.length}, Using ChatLogger ID: ${currentChatLoggerId}`);
    if (previousMessages.length > 0) {
        previousMessages.forEach((msg, index) => {
            console.log(`[ChatSessionManager][${this.managerInstanceId}] PreviousMessage ${index}: Type=${msg._getType()}, Content='${String(msg.content).substring(0, 70)}...'`);
        });
    } else {
        console.log(`[ChatSessionManager][${this.managerInstanceId}] No previous messages in history.`);
    }

    if (!skipSummaryAndReflection && previousLogPath && previousMessages.length > 1) {
        console.log(`[ChatSessionManager][${this.managerInstanceId}] Conditions met for reflection and summary generation. Proceeding...`);
        try {
            new Notice(`${previousLlmRoleName}が会話の振り返り(サマリー)を作成中です...`, 4000);
            const reflectionNoteFile = await this.reflectionTool.generateAndSaveReflection(
                previousMessages,
                previousLlmRoleName,
                previousLogPath.split('/').pop() || "unknown-log.md"
            );

            if (reflectionNoteFile instanceof TFile) {
                console.log(`[ChatSessionManager][${this.managerInstanceId}] Reflection and summary note generated: ${reflectionNoteFile.path}`);
                await this.chatLogger.updateLogFileFrontmatter(previousLogPath, {
                    title: reflectionNoteFile.basename.replace(/\.md$/, '').replace(/^SN-\d{12}-/, ''),
                    summary_note: `[[${reflectionNoteFile.name}]]`
                });
            } else if (typeof reflectionNoteFile === 'string' && reflectionNoteFile.startsWith("エラー:")) {
                console.warn(`[ChatSessionManager][${this.managerInstanceId}] Reflection tool returned an error string: ${reflectionNoteFile}`);
                new Notice(reflectionNoteFile);
            } else {
                 console.warn(`[ChatSessionManager][${this.managerInstanceId}] Reflection note generation failed or did not return a TFile. Returned: ${reflectionNoteFile}`);
                 new Notice(`振り返り兼サマリーノートの生成に失敗しました。`);
            }
        } catch (error: any) {
            console.error(`[ChatSessionManager][${this.managerInstanceId}] Error during reflection/summary note generation:`, error, error.stack);
            new Notice(`${previousLlmRoleName}による振り返り兼サマリーノートの作成に失敗しました。詳細: ${error.message}`);
        }
    } else {
        console.log(`[ChatSessionManager][${this.managerInstanceId}] Conditions NOT met for reflection and summary generation. Details:`);
        if (skipSummaryAndReflection) {
            console.log(" - Reason: Reflection was explicitly skipped (skipSummaryAndReflection is true).");
        }
        if (!previousLogPath) {
            console.log(" - Reason: previousLogPath is null or empty.");
        }
        if (!(previousMessages.length > 1)) {
            console.log(` - Reason: previousMessages.length is ${previousMessages.length}, which is not > 1.`);
        }
        if (previousLogPath && previousMessages.length <=1 && !skipSummaryAndReflection){
             console.log(`[ChatSessionManager][${this.managerInstanceId}] Skipping reflection as conversation did not have enough exchanges or log path was missing.`);
        }
    }

    this.chatLogger.resetLogFile();
    this.messageHistory = new ChatMessageHistory();

    this.uiManager.clearMessages();
    this.uiManager.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
    this.uiManager.resetInputField();
    this.uiManager.scrollToBottom();

    console.log(`[ChatSessionManager][${this.managerInstanceId}] Chat has been reset.`);

    if (!skipSummaryAndReflection && previousMessages.length > 1 && previousLogPath) {
        new Notice('新しいチャットが開始されました。');
    }
  }

  public async confirmAndDiscardChat(): Promise<void> {
    const messages = await this.messageHistory.getMessages();
    const currentLogPath = this.chatLogger.getLogFilePath();

    if (!currentLogPath && messages.length <= 1) {
        new Notice('破棄するチャットログがありません。');
        await this.resetChat(true);
        new Notice('現在のチャット（ログなし）が破棄され、新しいチャットが開始されました。');
        return;
    }

    const modal = new ConfirmationModal(
        this.app,
        'チャット履歴の破棄',
        '現在のチャット履歴を完全に破棄しますか？この操作は元に戻せません。ログファイルも削除され、振り返りノートも生成されません。',
        async () => {
            await this.discardCurrentChatLogAndReset();
        }
    );
    modal.open();
  }

  private async discardCurrentChatLogAndReset(): Promise<void> {
    const currentLogPath = this.chatLogger.getLogFilePath();
    if (currentLogPath) {
        await this.chatLogger.deleteLogFile(currentLogPath);
    } else {
        console.log(`[ChatSessionManager][${this.managerInstanceId}] No log file path set to delete.`);
    }
    await this.resetChat(true);
    new Notice('現在のチャットが破棄され、新しいチャットが開始されました。');
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