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
  private chatLogger: ChatLogger;
  // private summaryGenerator: SummaryGenerator; // 不要になる
  private tagProfiler: TagProfiler;
  private llmRoleName: string;
  private reflectionTool: ConversationReflectionTool;

  constructor(
    app: App,
    plugin: ObsidianMemoria,
    uiManager: ChatUIManager,
    chatLogger: ChatLogger,
    // summaryGenerator: SummaryGenerator, // 引数から削除
    tagProfiler: TagProfiler,
    initialLlmRoleName: string
  ) {
    this.app = app;
    this.plugin = plugin;
    this.uiManager = uiManager;
    this.chatLogger = chatLogger;
    // this.summaryGenerator = summaryGenerator; // 初期化を削除
    this.tagProfiler = tagProfiler; // TagProfiler は引き続き使用
    this.llmRoleName = initialLlmRoleName;
    this.messageHistory = new ChatMessageHistory();
    this.reflectionTool = new ConversationReflectionTool(this.plugin);
  }

  public updateLlmRoleName(newRoleName: string): void {
    this.llmRoleName = newRoleName;
    if (this.reflectionTool && typeof (this.reflectionTool as any).onSettingsChanged === 'function') {
        (this.reflectionTool as any).onSettingsChanged();
    }
    // TagProfiler も設定変更を通知する必要があればここで行う
    if (this.tagProfiler && typeof (this.tagProfiler as any).onSettingsChanged === 'function') {
        (this.tagProfiler as any).onSettingsChanged();
    }
  }

  public async resetChat(skipSummaryAndReflection = false): Promise<void> { // パラメータ名を変更
    const previousLogPath = this.chatLogger.getLogFilePath();
    const previousLlmRoleName = this.llmRoleName;
    const previousMessages = await this.messageHistory.getMessages();

    // --- 新しい振り返り兼サマリーノート生成処理 ---
    if (!skipSummaryAndReflection && previousLogPath && previousMessages.length > 1) {
        try {
            new Notice(`${previousLlmRoleName}が会話の振り返り(サマリー)を作成中です...`, 4000);
            const reflectionNoteFile = await this.reflectionTool.generateAndSaveReflection(
                previousMessages,
                previousLlmRoleName,
                previousLogPath.split('/').pop() || "unknown-log.md" // FullLogファイル名を渡す
            );

            if (reflectionNoteFile instanceof TFile) {
                console.log(`[ChatSessionManager] 振り返り兼サマリーノート生成完了: ${reflectionNoteFile.path}`);
                // new Notice(`振り返り兼サマリーノートが生成されました: ${reflectionNoteFile.basename}`); // ツール側で通知済み
                
                // FullLogのフロントマターを更新
                await this.chatLogger.updateLogFileFrontmatter(previousLogPath, {
                    title: reflectionNoteFile.basename.replace(/\.md$/, '').replace(/^SN-\d{12}-/, ''),
                    summary_note: `[[${reflectionNoteFile.name}]]` // リンクを更新
                });
                // TagProfilerによる処理はreflectionTool内部で行われるようになったため、ここでの呼び出しは不要
            } else if (typeof reflectionNoteFile === 'string' && reflectionNoteFile.startsWith("エラー:")) {
                new Notice(reflectionNoteFile); // エラーメッセージを通知
            } else {
                 new Notice(`振り返り兼サマリーノートの生成に失敗しました。`);
            }
        } catch (error: any) {
            console.error('[ChatSessionManager] 振り返り兼サマリーノート生成中にエラー:', error);
            new Notice(`${previousLlmRoleName}による振り返り兼サマリーノートの作成に失敗しました。`);
        }
    } else if (skipSummaryAndReflection) {
        console.log('[ChatSessionManager] 振り返り兼サマリーノートの生成はスキップされました。');
    }
    // --- 新しい振り返り兼サマリーノート生成処理 終了 ---

    this.chatLogger.resetLogFile();
    this.messageHistory = new ChatMessageHistory();

    this.uiManager.clearMessages();
    this.uiManager.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
    this.uiManager.resetInputField();
    this.uiManager.scrollToBottom();

    console.log('[ChatSessionManager] チャットがリセットされました。');

    if (!skipSummaryAndReflection && previousMessages.length > 1) {
        new Notice('新しいチャットが開始されました。');
    }
  }

  public async confirmAndDiscardChat(): Promise<void> {
    const messages = await this.messageHistory.getMessages();
    const currentLogPath = this.chatLogger.getLogFilePath();

    if (!currentLogPath && messages.length <= 1) {
        new Notice('破棄するチャットログがありません。');
        await this.resetChat(true); // サマリーと感想生成をスキップ
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
        console.log('[ChatSessionManager] 削除対象のログファイルパスが設定されていません。');
    }
    await this.resetChat(true); // サマリーと感想生成をスキップしてリセット
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
