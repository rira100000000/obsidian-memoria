// src/ui/chatSessionManager.ts
import { App, Notice, TFile } from 'obsidian';
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { BaseMessage } from "@langchain/core/messages";
import { ChatUIManager, ConfirmationModal } from './ui/chatUIManager';
import { ChatLogger } from './chatLogger';
import { SummaryGenerator } from './summaryGenerator';
import { TagProfiler } from './tagProfiler';
import ObsidianMemoria from './../main'; // Pluginの型情報のため

/**
 * ChatSessionManagerクラス
 * チャットセッションのライフサイクル管理（開始、リセット、破棄）、
 * メッセージ履歴の管理、およびセッション終了時の後処理を担当します。
 */
export class ChatSessionManager {
  private app: App;
  private plugin: ObsidianMemoria; // SummaryGeneratorなどに渡すため
  public messageHistory: ChatMessageHistory;
  private uiManager: ChatUIManager;
  private chatLogger: ChatLogger;
  private summaryGenerator: SummaryGenerator;
  private tagProfiler: TagProfiler;
  private llmRoleName: string; // 現在のLLMロール名

  constructor(
    app: App,
    plugin: ObsidianMemoria,
    uiManager: ChatUIManager,
    chatLogger: ChatLogger,
    summaryGenerator: SummaryGenerator,
    tagProfiler: TagProfiler,
    initialLlmRoleName: string
  ) {
    this.app = app;
    this.plugin = plugin;
    this.uiManager = uiManager;
    this.chatLogger = chatLogger;
    this.summaryGenerator = summaryGenerator;
    this.tagProfiler = tagProfiler;
    this.llmRoleName = initialLlmRoleName;
    this.messageHistory = new ChatMessageHistory();
  }

  /**
   * LLMのロール名を更新します。
   * @param newRoleName 新しいLLMのロール名。
   */
  public updateLlmRoleName(newRoleName: string): void {
    this.llmRoleName = newRoleName;
  }

  /**
   * 現在のチャットセッションをリセットします。
   * UIをクリアし、メッセージ履歴を初期化し、必要に応じて前のチャットのサマリーを生成します。
   * @param {boolean} [skipSummary=false] 前のチャットのサマリー生成をスキップするかどうか。
   */
  public async resetChat(skipSummary = false): Promise<void> {
    const previousLogPath = this.chatLogger.getLogFilePath();
    const previousLlmRoleName = this.llmRoleName; // リセット前のロール名を保持

    this.chatLogger.resetLogFile(); // ログファイルパスをリセット
    this.messageHistory = new ChatMessageHistory(); // メッセージ履歴をクリア

    // UIのクリアと初期化
    this.uiManager.clearMessages();
    this.uiManager.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
    this.uiManager.resetInputField();
    this.uiManager.scrollToBottom();

    console.log('[ChatSessionManager] Chat has been reset.');

    if (!skipSummary) {
        new Notice('新しいチャットが開始されました。');
    }

    // 前のチャットのサマリー生成 (skipSummaryがfalseの場合のみ)
    if (!skipSummary && previousLogPath && previousLlmRoleName) {
      new Notice(`前のチャットの要約をバックグラウンドで生成開始します: ${previousLogPath}`);
      this.summaryGenerator.generateSummary(previousLogPath, previousLlmRoleName)
        .then(async (summaryNoteFile: TFile | null) => {
          if (summaryNoteFile) {
            console.log(`[ChatSessionManager] Summary generation completed: ${summaryNoteFile.path}`);
            new Notice(`サマリーノートが生成されました: ${summaryNoteFile.basename}`);
            // ChatLogger を使ってログファイルのフロントマターを更新
            await this.chatLogger.updateLogFileFrontmatter(previousLogPath, {
                title: summaryNoteFile.basename.replace(/\.md$/, '').replace(/^SN-\d{12}-/, ''), // SN-YYYYMMDDHHMM-Title -> Title
                summary_note: `[[${summaryNoteFile.name}]]`
            });

            try {
              await this.tagProfiler.processSummaryNote(summaryNoteFile);
              console.log(`[ChatSessionManager] Tag profiling initiated for ${summaryNoteFile.path}`);
              new Notice(`タグプロファイル処理を開始しました: ${summaryNoteFile.basename}`);
            } catch (tpError: any) {
              console.error(`[ChatSessionManager] Error during tag profiling for ${summaryNoteFile.path}:`, tpError.message, tpError.stack);
              new Notice(`タグプロファイル処理中にエラーが発生しました: ${summaryNoteFile.basename}`);
            }
          } else {
            console.log(`[ChatSessionManager] Summary generation for ${previousLogPath} did not return a file.`);
            new Notice(`前のチャット (${previousLogPath}) のサマリーノートファイルが取得できませんでした。`);
          }
        })
        .catch(error => {
          console.error(`[ChatSessionManager] Summary generation failed for ${previousLogPath}:`, error);
          new Notice(`前のチャット (${previousLogPath}) の要約作成に失敗しました。`);
        });
    } else if (skipSummary) {
      console.log('[ChatSessionManager] Summary generation skipped for previous chat.');
    }
  }

  /**
   * 現在のチャットログを破棄するかユーザーに確認し、同意が得られれば破棄処理を実行します。
   */
  public async confirmAndDiscardChat(): Promise<void> {
    const messages = await this.messageHistory.getMessages();
    const currentLogPath = this.chatLogger.getLogFilePath();

    // ログファイルがなく、かつメッセージ履歴が初期メッセージのみの場合は、確認なしでリセット
    if (!currentLogPath && messages.length <= 1) { // 初期メッセージはAIからのものなので1以下
        new Notice('破棄するチャットログがありません。');
        await this.resetChat(true); // サマリー生成をスキップしてリセット
        new Notice('現在のチャット（ログなし）が破棄され、新しいチャットが開始されました。');
        return;
    }

    const modal = new ConfirmationModal(
        this.app,
        'チャット履歴の破棄',
        '現在のチャット履歴を完全に破棄しますか？この操作は元に戻せません。ログファイルも削除されます。',
        async () => {
            await this.discardCurrentChatLogAndReset();
        }
    );
    modal.open();
  }

  /**
   * 現在のチャットログファイル（存在すれば）を削除し、セッションをリセットします。
   */
  private async discardCurrentChatLogAndReset(): Promise<void> {
    const currentLogPath = this.chatLogger.getLogFilePath();
    if (currentLogPath) {
        await this.chatLogger.deleteLogFile(currentLogPath);
        // ChatLogger内で currentLogFilePath は null に設定される
    } else {
        console.log('[ChatSessionManager] No log file path set, resetting UI and history.');
    }
    await this.resetChat(true); // サマリー生成をスキップしてチャットをリセット
    new Notice('現在のチャットが破棄され、新しいチャットが開始されました。');
  }

  /**
   * メッセージ履歴を取得します。
   * @returns {Promise<BaseMessage[]>} メッセージの配列。
   */
  public async getMessages(): Promise<BaseMessage[]> {
    return this.messageHistory.getMessages();
  }

  /**
   * メッセージ履歴にメッセージを追加します。
   * @param {BaseMessage} message 追加するメッセージ。
   */
  public async addMessage(message: BaseMessage): Promise<void> {
    await this.messageHistory.addMessage(message);
  }
}
