// src/chatSessionManager.ts
import { App, Notice, TFile } from 'obsidian';
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatUIManager, ConfirmationModal } from './ui/chatUIManager';
import { ChatLogger } from './chatLogger';
import { TagProfiler } from './tagProfiler';
import ObsidianMemoria from './../main';
import { ConversationReflectionTool } from './tools/conversationReflectionTool';

export class ChatSessionManager {
    private app: App;
    private plugin: ObsidianMemoria;
    public messageHistory: ChatMessageHistory;
    private uiManager: ChatUIManager;
    private chatLogger: ChatLogger;
    private tagProfiler: TagProfiler;
    private llmRoleName: string;
    private managerInstanceId: string;
    private reflectionTool: ConversationReflectionTool;
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
        this.messageHistory = new ChatMessageHistory();
        this.managerInstanceId = Math.random().toString(36).substring(2, 8);
        console.log(`[ChatSessionManager][${this.managerInstanceId}] New instance created. Initial RoleName: ${initialLlmRoleName}. Using ChatLogger ID: ${(this.chatLogger as any).instanceId}`);
        this.reflectionTool = new ConversationReflectionTool(this.plugin);
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
            if (!skipSummaryAndReflection && previousLogPath && previousMessages.length > 1) {
                console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Conditions met for reflection. Calling reflectionTool.generateAndSaveReflection...`);
                
                // reflectionTool.generateAndSaveReflection の呼び出し前のNoticeは削除し、Tool内部のNoticeに統一
                // new Notice(`${previousLlmRoleName}が会話の振り返り(サマリー)を作成中です...`, 4000); 
                
                const reflectionNoteFile = await this.reflectionTool.generateAndSaveReflection(
                    previousMessages,
                    previousLlmRoleName,
                    previousLogPath.split('/').pop() || "unknown-log.md"
                );

                console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] reflectionTool.generateAndSaveReflection FINISHED. Returned:`, reflectionNoteFile);
                console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Type of reflectionNoteFile: ${typeof reflectionNoteFile}`);

                if (reflectionNoteFile instanceof TFile) {
                    console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Reflection note is a TFile. Path: ${reflectionNoteFile.path}`);
                    console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Displaying Notice: Reflection and summary note generated: ${reflectionNoteFile.basename}`);
                    new Notice(`Reflection and summary note generated: ${reflectionNoteFile.basename}`); // ChatSessionManagerからの成功通知
                    await this.chatLogger.updateLogFileFrontmatter(previousLogPath, {
                        title: reflectionNoteFile.basename.replace(/\.md$/, '').replace(/^SN-\d{12}-/, ''),
                        summary_note: `[[${reflectionNoteFile.name}]]`
                    });
                } else if (typeof reflectionNoteFile === 'string' && reflectionNoteFile.startsWith("エラー:")) {
                    console.warn(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Reflection tool returned an error string: ${reflectionNoteFile}`);
                    console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Displaying Notice (from error string): ${reflectionNoteFile}`);
                    new Notice(reflectionNoteFile); // ReflectionToolからのエラーメッセージをそのまま表示
                } else {
                    console.warn(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Reflection note generation failed or did not return a TFile or expected error string. Returned: ${reflectionNoteFile}`);
                    console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Displaying Notice: 振り返り兼サマリーノートの生成に失敗しました。(Unexpected return)`);
                    new Notice(`振り返り兼サマリーノートの生成に失敗しました。(Unexpected return)`);
                }
            } else {
                console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Conditions NOT met for reflection and summary generation. Details:`);
                if (skipSummaryAndReflection) console.log(" - Reason: Reflection was explicitly skipped.");
                if (!previousLogPath) console.log(" - Reason: previousLogPath is null or empty.");
                if (!(previousMessages.length > 1)) console.log(` - Reason: previousMessages.length is ${previousMessages.length}, not > 1.`);
            }

            console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Resetting chatLogger and messageHistory...`);
            this.chatLogger.resetLogFile();
            this.messageHistory = new ChatMessageHistory();

            this.uiManager.clearMessages();
            this.uiManager.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
            this.uiManager.resetInputField();
            this.uiManager.scrollToBottom();

            console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Chat has been reset.`);

            if (!skipSummaryAndReflection && previousMessages.length > 1 && previousLogPath && (await this.messageHistory.getMessages()).length === 0) { // 最後の条件はリセット成功確認
                 console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Displaying Notice: 新しいチャットが開始されました。`);
                new Notice('新しいチャットが開始されました。');
            }
        } catch (error: any) {
            console.error(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] UNEXPECTED ERROR in resetChat:`, error, error.stack);
            console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] Displaying Notice: チャットリセット中に予期せぬエラーが発生しました。`);
            new Notice(`チャットリセット中に予期せぬエラーが発生しました。詳細はコンソールを確認してください。`);
        } finally {
            this.isResetting = false;
            console.log(`[ChatSessionManager][${this.managerInstanceId}][ResetCall-${resetCallId}] isResetting SET to false in finally block. Reset process finished.`);
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
    }

    public async addUserMessage(textContent: string): Promise<void> {
        await this.messageHistory.addMessage(new HumanMessage(textContent));
    }

    public async addAiMessage(textContent: string): Promise<void> {
        await this.messageHistory.addMessage(new AIMessage(textContent));
    }
}
