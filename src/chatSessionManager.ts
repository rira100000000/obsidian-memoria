// src/chatSessionManager.ts
import { App, Notice, TFile } from 'obsidian';
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { BaseMessage, HumanMessage, AIMessage } // AIMessage, HumanMessage をインポート
from "@langchain/core/messages";
import { ChatUIManager, ConfirmationModal } from './ui/chatUIManager';
import { ChatLogger } from './chatLogger';
import { SummaryGenerator } from './summaryGenerator';
import { TagProfiler } from './tagProfiler';
import ObsidianMemoria from './../main'; // Pluginの型情報のため
import { ConversationReflectionTool } from './tools/conversationReflectionTool'; // 追加: ConversationReflectionToolをインポート

/**
 * ChatSessionManagerクラス
 * チャットセッションのライフサイクル管理（開始、リセット、破棄）、
 * メッセージ履歴の管理、およびセッション終了時の後処理を担当します。
 */
export class ChatSessionManager {
  private app: App;
  private plugin: ObsidianMemoria;
  public messageHistory: ChatMessageHistory;
  private uiManager: ChatUIManager;
  private chatLogger: ChatLogger;
  private summaryGenerator: SummaryGenerator;
  private tagProfiler: TagProfiler;
  private llmRoleName: string;
  private reflectionTool: ConversationReflectionTool; // 追加: ConversationReflectionToolのインスタンス

  /**
   * ChatSessionManagerのコンストラクタ。
   * @param app ObsidianのAppインスタンス。
   * @param plugin ObsidianMemoriaプラグインのインスタンス。
   * @param uiManager ChatUIManagerのインスタンス。
   * @param chatLogger ChatLoggerのインスタンス。
   * @param summaryGenerator SummaryGeneratorのインスタンス。
   * @param tagProfiler TagProfilerのインスタンス。
   * @param initialLlmRoleName 初期LLMロール名。
   */
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

    // ConversationReflectionToolのインスタンスを作成
    // ここで渡すLLMインスタンスは、ChatViewで初期化されたメインのチャットLLMを渡すか、
    // ReflectionTool内部で別途初期化するかを選択できます。
    // 今回はReflectionTool内部で初期化する設計のため、第二引数は省略。
    this.reflectionTool = new ConversationReflectionTool(this.plugin);
  }

  /**
   * LLMのロール名を更新します。
   * これは主にプラグイン設定が変更された際にChatViewから呼び出されます。
   * @param newRoleName 新しいLLMのロール名。
   */
  public updateLlmRoleName(newRoleName: string): void {
    this.llmRoleName = newRoleName;
    // ReflectionToolも設定に依存している可能性があるため、設定変更を通知
    if (this.reflectionTool && typeof (this.reflectionTool as any).onSettingsChanged === 'function') {
        (this.reflectionTool as any).onSettingsChanged();
    }
  }

  /**
   * 現在のチャットセッションをリセットします。
   * UIをクリアし、メッセージ履歴を初期化し、必要に応じて前のチャットのサマリーとLLMの感想を生成します。
   * @param skipSummary 前のチャットのサマリー生成をスキップするかどうか。デフォルトはfalse。
   * @param skipReflection 前のチャットのLLMによる感想生成をスキップするかどうか。デフォルトはfalse。
   */
  public async resetChat(skipSummary = false, skipReflection = false): Promise<void> {
    const previousLogPath = this.chatLogger.getLogFilePath();
    const previousLlmRoleName = this.llmRoleName; // リセット前のロール名を保持
    const previousMessages = await this.messageHistory.getMessages(); // クリア前のメッセージ履歴を取得

    // --- LLMによる会話の感想生成処理 ---
    // skipReflectionがfalseで、かつ会話履歴が初期メッセージ（通常AIからの挨拶1件）よりも多い場合
    if (!skipReflection && previousMessages.length > 1) {
        try {
            // ユーザーに感想生成中であることを通知（時間は短めに）
            // new Notice(`${previousLlmRoleName}が過去の会話について感想を生成中です...`, 3000);
            // 感想生成ツールを呼び出し
            const reflectionResult = await this.reflectionTool.generateAndSaveReflection(
                previousMessages,
                previousLlmRoleName // 現在のLLMロール名（感想生成時の視点となるペルソナ名）
            );
            console.log(`[ChatSessionManager] 感想生成ツールの結果: ${reflectionResult}`);
            // エラーがあればユーザーに通知（成功時はツール側で通知済みのはず）
            if (reflectionResult.startsWith("エラー:")) {
                new Notice(reflectionResult);
            }
        } catch (reflectionError: any) {
            console.error('[ChatSessionManager] 会話の感想生成中にエラーが発生しました:', reflectionError);
            new Notice(`${previousLlmRoleName}による会話の感想生成に失敗しました。`);
        }
    } else if (skipReflection) {
        console.log('[ChatSessionManager] 前の会話の感想生成はスキップされました。');
    }
    // --- 感想生成処理 終了 ---

    // ログファイルパスとメッセージ履歴をリセット
    this.chatLogger.resetLogFile();
    this.messageHistory = new ChatMessageHistory();

    // UIのクリアと初期化
    this.uiManager.clearMessages();
    // 新しいチャット開始時の初期メッセージ（AIからの挨拶）
    // このメッセージは履歴には追加せず、UIに表示するだけとする場合もある
    // ここではUIに表示し、必要であれば履歴にも追加する（ChatView側の実装による）
    this.uiManager.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
    this.uiManager.resetInputField();
    this.uiManager.scrollToBottom();

    console.log('[ChatSessionManager] チャットがリセットされました。');

    // 新しいチャット開始の通知 (サマリーと感想生成の両方がスキップされない場合)
    if (!skipSummary || !skipReflection) { // どちらか一方でも実行されたら通知
        if (previousMessages.length > 1) { // 実質的な会話があった場合のみ
             new Notice('新しいチャットが開始されました。');
        }
    }


    // --- 前のチャットのサマリー生成処理 ---
    // skipSummaryがfalseで、かつ前のログファイルパスとLLMロール名が存在する場合
    if (!skipSummary && previousLogPath && previousLlmRoleName) {
      new Notice(`前のチャットの要約をバックグラウンドで生成開始します: ${previousLogPath}`);
      // サマリージェネレーターを呼び出し
      this.summaryGenerator.generateSummary(previousLogPath, previousLlmRoleName)
        .then(async (summaryNoteFile: TFile | null) => {
          if (summaryNoteFile) {
            console.log(`[ChatSessionManager] サマリー生成完了: ${summaryNoteFile.path}`);
            new Notice(`サマリーノートが生成されました: ${summaryNoteFile.basename}`);
            // ログファイルのフロントマターを更新 (サマリーノートへのリンクなど)
            await this.chatLogger.updateLogFileFrontmatter(previousLogPath, {
                title: summaryNoteFile.basename.replace(/\.md$/, '').replace(/^SN-\d{12}-/, ''),
                summary_note: `[[${summaryNoteFile.name}]]`
            });

            // タグプロファイリング処理を開始
            try {
              await this.tagProfiler.processSummaryNote(summaryNoteFile);
              console.log(`[ChatSessionManager] タグプロファイル処理を開始しました: ${summaryNoteFile.path}`);
              new Notice(`タグプロファイル処理を開始しました: ${summaryNoteFile.basename}`);
            } catch (tpError: any) {
              console.error(`[ChatSessionManager] タグプロファイル処理中にエラーが発生しました (${summaryNoteFile.path}):`, tpError.message, tpError.stack);
              new Notice(`タグプロファイル処理中にエラーが発生しました: ${summaryNoteFile.basename}`);
            }
          } else {
            console.log(`[ChatSessionManager] サマリー生成 (${previousLogPath}) はファイルオブジェクトを返しませんでした。`);
            new Notice(`前のチャット (${previousLogPath}) のサマリーノートファイルが取得できませんでした。`);
          }
        })
        .catch(error => {
          console.error(`[ChatSessionManager] サマリー生成に失敗しました (${previousLogPath}):`, error);
          new Notice(`前のチャット (${previousLogPath}) の要約作成に失敗しました。`);
        });
    } else if (skipSummary) {
      console.log('[ChatSessionManager] 前のチャットのサマリー生成はスキップされました。');
    }
    // --- サマリー生成処理 終了 ---
  }

  /**
   * 現在のチャットログを破棄するかユーザーに確認し、同意が得られれば破棄処理を実行します。
   * 破棄する場合、サマリー生成とLLMによる感想生成は行われません。
   */
  public async confirmAndDiscardChat(): Promise<void> {
    const messages = await this.messageHistory.getMessages();
    const currentLogPath = this.chatLogger.getLogFilePath();

    // ログファイルがなく、かつメッセージ履歴が初期メッセージ（AIからの挨拶1件）のみの場合は、確認なしでリセット
    if (!currentLogPath && messages.length <= 1) {
        new Notice('破棄するチャットログがありません。');
        // サマリー生成と感想生成の両方をスキップしてリセット
        await this.resetChat(true, true);
        new Notice('現在のチャット（ログなし）が破棄され、新しいチャットが開始されました。');
        return;
    }

    // 確認モーダルを表示
    const modal = new ConfirmationModal(
        this.app,
        'チャット履歴の破棄',
        '現在のチャット履歴を完全に破棄しますか？この操作は元に戻せません。ログファイルも削除され、LLMによる会話の感想も生成されません。',
        async () => {
            // ユーザーが「はい」を選択した場合、チャットログを削除し、感想生成をスキップしてリセット
            await this.discardCurrentChatLogAndReset(true);
        }
    );
    modal.open();
  }

  /**
   * 現在のチャットログファイル（存在すれば）を削除し、セッションをリセットします。
   * @param skipReflection 感想生成をスキップするかどうか。通常、破棄時はtrue。
   */
  private async discardCurrentChatLogAndReset(skipReflection = true): Promise<void> {
    const currentLogPath = this.chatLogger.getLogFilePath();
    if (currentLogPath) {
        // ログファイルを削除
        await this.chatLogger.deleteLogFile(currentLogPath);
        // ChatLogger内で currentLogFilePath は null に設定される
    } else {
        console.log('[ChatSessionManager] 削除対象のログファイルパスが設定されていません。UIと履歴のみリセットします。');
    }
    // サマリー生成は常にスキップ(true)、感想生成は引数に従ってチャットをリセット
    await this.resetChat(true, skipReflection);
    new Notice('現在のチャットが破棄され、新しいチャットが開始されました。');
  }

  /**
   * 現在のメッセージ履歴を取得します。
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

  /**
   * メッセージ履歴にユーザーメッセージを追加します。
   * @param {string} textContent ユーザーメッセージのテキスト内容。
   */
  public async addUserMessage(textContent: string): Promise<void> {
    await this.messageHistory.addMessage(new HumanMessage(textContent));
  }

  /**
   * メッセージ履歴にAIメッセージを追加します。
   * @param {string} textContent AIメッセージのテキスト内容。
   */
  public async addAiMessage(textContent: string): Promise<void> {
    await this.messageHistory.addMessage(new AIMessage(textContent));
  }
}
