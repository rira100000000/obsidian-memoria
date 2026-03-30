// src/chatSessionManager.ts
import { App, Notice, TFile } from 'obsidian';
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatUIManager, ConfirmationModal } from './ui/chatUIManager';
import { ChatLogger } from './chatLogger';
import { TagProfiler } from './tagProfiler';
import ObsidianMemoria from './../main';
import { ConversationReflectionTool } from './tools/conversationReflectionTool';
import { NarrativeBuffer } from './narrativeBuffer';

export class ChatSessionManager {
    private app: App;
    private plugin: ObsidianMemoria;
    public messageHistory: InMemoryChatMessageHistory;
    private uiManager: ChatUIManager;
    private chatLogger: ChatLogger;
    private tagProfiler: TagProfiler;
    private llmRoleName: string;
    private managerInstanceId: string;
    private reflectionTool: ConversationReflectionTool;
    public narrativeBuffer: NarrativeBuffer;
    private isResetting = false;

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
        this.messageHistory = new InMemoryChatMessageHistory();
        this.managerInstanceId = Math.random().toString(36).substring(2, 8);
        console.log(`[ChatSessionManager][${this.managerInstanceId}] New instance created. Initial RoleName: ${initialLlmRoleName}. Using ChatLogger ID: ${(this.chatLogger as any).instanceId}`);
        this.reflectionTool = new ConversationReflectionTool(this.plugin);
        this.narrativeBuffer = new NarrativeBuffer(this.plugin.settings);
    }

    public updateLlmRoleName(newRoleName: string): void {
        const oldRoleName = this.llmRoleName;
        this.llmRoleName = newRoleName;
        console.log(`[ChatSessionManager][${this.managerInstanceId}] llmRoleName updated from '${oldRoleName}' to '${this.llmRoleName}'`);
    }

    public updateChatLogger(newChatLogger: ChatLogger): void {
        const oldLoggerId = this.chatLogger ? (this.chatLogger as any).instanceId : 'N/A';
        this.chatLogger = newChatLogger;
        console.log(`[ChatSessionManager][${this.managerInstanceId}] ChatLogger instance updated. Old ID: ${oldLoggerId}, New ID: ${(this.chatLogger as any).instanceId}`);
    }

    public async resetChat(skipSummaryAndReflection = false): Promise<void> {
        const resetCallId = Math.random().toString(36).substring(2, 8); // この呼び出し固有のID
        console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] resetChat CALLED. skipSummaryAndReflection: ${skipSummaryAndReflection}. Current isResetting: ${this.isResetting}`);

        if (this.isResetting) {
            console.warn(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] resetChat SKIPPED as already resetting.`);
            return;
        }
        this.isResetting = true;
        console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] isResetting SET to true. Proceeding with reset logic.`);

        const currentChatLoggerId = this.chatLogger ? (this.chatLogger as any).instanceId : 'N/A';
        console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Attempting to get log path from ChatLogger ID: ${currentChatLoggerId}`);
        const previousLogPath = this.chatLogger.getLogFilePath();
        const previousLlmRoleName = this.llmRoleName;
        const previousMessages = await this.messageHistory.getMessages();

        console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Initiating reset. SkipReflection: ${skipSummaryAndReflection}, LogPath: '${previousLogPath}', MessagesCount: ${previousMessages.length}`);

        try {
            // 振り返り処理をバックグラウンドで実行（UIリセットをブロックしない）
            const alreadyReflected = this.reflectionTool.getLastCreatedFile() !== null;
            if (alreadyReflected) {
                this.uiManager.addDebugLogEntry('振り返り', `会話中にAIが振り返りノートを作成済み（${this.reflectionTool.getLastCreatedFile()?.basename}）。再生成をスキップ`);
            } else if (!skipSummaryAndReflection && previousLogPath && previousMessages.length > 1) {
                this.uiManager.addDebugLogEntry('振り返り', `振り返りノート生成をバックグラウンドで開始 (メッセージ数: ${previousMessages.length})`);

                // バックグラウンドで振り返り処理を実行（chatLoggerはリセット前にパスを保存）
                const logPathForReflection = previousLogPath;
                const chatLoggerForReflection = this.chatLogger;
                this.reflectionTool.generateAndSaveReflection(
                    previousMessages,
                    previousLlmRoleName,
                    logPathForReflection.split('/').pop() || "unknown-log.md"
                ).then(async (reflectionNoteFile) => {
                    if (reflectionNoteFile instanceof TFile) {
                        this.uiManager.addDebugLogEntry('振り返り', `振り返りノート作成完了: ${reflectionNoteFile.basename}`);
                        new Notice(`振り返りノートが作成されました: ${reflectionNoteFile.basename}`);
                        await chatLoggerForReflection.updateLogFileFrontmatter(logPathForReflection, {
                            title: reflectionNoteFile.basename.replace(/\.md$/, '').replace(/^SN-\d{12}-/, ''),
                            summary_note: `[[${reflectionNoteFile.name}]]`
                        });
                    } else if (typeof reflectionNoteFile === 'string' && reflectionNoteFile.startsWith("エラー:")) {
                        this.uiManager.addDebugLogEntry('振り返り', `振り返りエラー: ${reflectionNoteFile}`);
                        new Notice(reflectionNoteFile);
                    }
                }).catch((error: any) => {
                    console.error(`[ChatSessionManager] Background reflection failed:`, error);
                    this.uiManager.addDebugLogEntry('振り返り', `バックグラウンド振り返りエラー: ${error.message}`);
                });
            } else {
                let reason = '';
                if (skipSummaryAndReflection) reason = '明示的にスキップ';
                else if (!previousLogPath) reason = 'ログファイルなし';
                else if (previousMessages.length <= 1) reason = `メッセージ数不足 (${previousMessages.length})`;
                this.uiManager.addDebugLogEntry('振り返り', `振り返り生成条件を満たさず: ${reason}`);
            }

            // UIは即座にリセット
            this.chatLogger.resetLogFile();
            this.messageHistory = new InMemoryChatMessageHistory();
            this.narrativeBuffer.reset();
            this.reflectionTool.clearLastCreatedFile();

            this.uiManager.clearMessages();
            this.uiManager.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
            this.uiManager.resetInputField();
            this.uiManager.scrollToBottom();

            console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Chat has been reset. Reflection running in background.`);
        } catch (error: any) {
            console.error(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] UNEXPECTED ERROR in resetChat:`, error, error.stack);
            new Notice(`チャットリセット中に予期せぬエラーが発生しました。`);
        } finally {
            this.isResetting = false;
        }
    }

    public async confirmAndDiscardChat(): Promise<void> {
        const discardCallId = Math.random().toString(36).substring(2, 8);
        console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardCall-${discardCallId}] confirmAndDiscardChat CALLED.`);
        const messages = await this.messageHistory.getMessages();
        const currentLogPath = this.chatLogger.getLogFilePath();

        if (!currentLogPath && messages.length <= 1) {
            console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardCall-${discardCallId}] No substantial chat log to discard. Resetting without summary.`);
            console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardCall-${discardCallId}] Displaying Notice: 破棄するチャットログが実質的にありません。`);
            new Notice('破棄するチャットログが実質的にありません。');
            await this.resetChat(true);
            return;
        }
        
        console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardCall-${discardCallId}] Opening confirmation modal.`);
        const modal = new ConfirmationModal(
            this.app,
            'チャット履歴の破棄',
            '現在のチャット履歴と関連ログファイルを完全に破棄しますか？この操作は元に戻せません。振り返りノートも生成されません。',
            async () => {
                console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardCall-${discardCallId}] Confirmation received. Discarding chat log and resetting.`);
                await this.discardCurrentChatLogAndReset();
            }
        );
        modal.open();
    }

    private async discardCurrentChatLogAndReset(): Promise<void> {
        const discardResetId = Math.random().toString(36).substring(2, 8);
        console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardReset-${discardResetId}] discardCurrentChatLogAndReset CALLED.`);
        const currentLogPath = this.chatLogger.getLogFilePath();
        if (currentLogPath) {
            console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardReset-${discardResetId}] Deleting log file: ${currentLogPath}`);
            await this.chatLogger.deleteLogFile(currentLogPath);
        } else {
            console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardReset-${discardResetId}] No log file path set to delete.`);
        }
        await this.resetChat(true); // skipSummaryAndReflection を true にしてリセット
        console.log(`[ChatSessionManager][${this.managerInstanceId}][DiscardReset-${discardResetId}] discardCurrentChatLogAndReset FINISHED.`);
    }

    public async getMessages(): Promise<BaseMessage[]> {
        return this.messageHistory.getMessages();
    }

    public async addMessage(message: BaseMessage): Promise<void> {
        await this.messageHistory.addMessage(message);
        const allMessages = await this.messageHistory.getMessages();
        this.narrativeBuffer.onMessagesUpdated(allMessages).catch(e => {
            console.error("[ChatSessionManager] Background narrative buffer update failed:", e.message);
        });
    }

    public async addUserMessage(textContent: string): Promise<void> {
        await this.messageHistory.addMessage(new HumanMessage(textContent));
        const allMessages = await this.messageHistory.getMessages();
        this.narrativeBuffer.onMessagesUpdated(allMessages).catch(e => {
            console.error("[ChatSessionManager] Background narrative buffer update failed:", e.message);
        });
    }

    public async addAiMessage(textContent: string): Promise<void> {
        await this.messageHistory.addMessage(new AIMessage(textContent));
        const allMessages = await this.messageHistory.getMessages();
        this.narrativeBuffer.onMessagesUpdated(allMessages).catch(e => {
            console.error("[ChatSessionManager] Background narrative buffer update failed:", e.message);
        });
    }
}
