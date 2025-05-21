// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice, moment, TFile, Modal, App, Setting } from 'obsidian'; // Modal, App, Setting をインポート
import ObsidianMemoria from '../../main';
import { GeminiPluginSettings } from '../settings';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { SummaryGenerator } from './../summaryGenerator';

export const CHAT_VIEW_TYPE = 'obsidian-memoria-chat-view';

// 警告モーダルクラス
class ConfirmationModal extends Modal {
  constructor(app: App, private titleText: string, private messageText: string, private onConfirm: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.titleText);
    contentEl.createEl('p', { text: this.messageText });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('はい (Yes)')
          .setCta()
          .onClick(() => {
            this.onConfirm();
            this.close();
          }))
      .addButton((btn) =>
        btn
          .setButtonText('いいえ (No)')
          .onClick(() => {
            this.close();
          }));
  }

  onClose() {
    this.contentEl.empty();
  }
}


export class ChatView extends ItemView {
  plugin: ObsidianMemoria;
  settings: GeminiPluginSettings;
  chatMessagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;

  private messageHistory = new ChatMessageHistory();
  private chatModel: ChatGoogleGenerativeAI | null = null;
  private chainWithHistory: RunnableWithMessageHistory<Record<string, any>, BaseMessage> | null = null;

  private logFilePath: string | null = null;
  private llmRoleName = 'Assistant';
  private summaryGenerator: SummaryGenerator;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.summaryGenerator = new SummaryGenerator(this.plugin);
  }

  private getLlmRoleName(systemPrompt: string): string {
    if (!systemPrompt) return 'Assistant';
    let match;
    match = systemPrompt.match(/named\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/Your name is\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/Your role is\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/^You are (?:a|an)\s+([\w\s-]+?)(?:\.|$)/i);
    if (match && match[1]) {
        const role = match[1].trim();
        const lowerRole = role.toLowerCase();
        if (lowerRole === 'helpful assistant' || lowerRole === 'ai assistant' || lowerRole === 'assistant') {
            return 'Assistant';
        }
        return role;
    }
    return 'Assistant';
  }

  private initializeChatModel() {
    this.settings = this.plugin.settings;
    const systemPromptFromSettings = this.settings.systemPrompt || "You are a helpful assistant integrated into Obsidian.";
    this.llmRoleName = this.getLlmRoleName(systemPromptFromSettings);

    if (this.settings.geminiApiKey && this.settings.geminiModel) {
      try {
        this.chatModel = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: this.settings.geminiModel,
        });
        const prompt = ChatPromptTemplate.fromMessages([
          new SystemMessage(systemPromptFromSettings),
          new MessagesPlaceholder("history"),
          ["human", "{input}"],
        ]);
        const chain = prompt.pipe(this.chatModel);
        this.chainWithHistory = new RunnableWithMessageHistory({
            runnable: chain,
            getMessageHistory: (_sessionId) => this.messageHistory,
            inputMessagesKey: "input",
            historyMessagesKey: "history",
        });
        console.log(`[MemoriaChat] Chat model initialized. LLM Role: ${this.llmRoleName}`);
      } catch (error: any) {
        console.error('[MemoriaChat] Failed to initialize ChatGoogleGenerativeAI model or chain:', error.message);
        new Notice('Geminiモデルまたはチャットチェーンの初期化に失敗しました。');
        this.chatModel = null;
        this.chainWithHistory = null;
      }
    } else {
      console.log('[MemoriaChat] API key or model name not set. Chat model not initialized.');
      this.chatModel = null;
      this.chainWithHistory = null;
    }
  }

  onSettingsChanged() {
    this.initializeChatModel();
    this.summaryGenerator.onSettingsChanged();
    console.log('[MemoriaChat] Settings changed, chat model and summary generator re-initialized.');
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return 'Memoria Chat'; }
  getIcon() { return 'messages-square'; }

  async onOpen() {
    this.settings = this.plugin.settings;
    this.initializeChatModel();
    // await this.setupLogging(); // ログ作成を onOpen から sendMessage に移動

    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('memoria-chat-view-container');

    const styleEl = container.createEl('style');
    styleEl.textContent = `
      .memoria-chat-view-container { display: flex; flex-direction: column; height: 100%; }
      .memoria-chat-header { display: flex; justify-content: flex-end; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--background-modifier-border); background-color: var(--background-primary); flex-shrink: 0; }
      .memoria-chat-header button { margin-left: 8px; } /* ボタン間のマージンを追加 */
      .memoria-new-chat-button { /* new chat button styles */ }
      .memoria-discard-chat-button { /* discard chat button styles */ }
      .memoria-chat-messages-wrapper { flex-grow: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; }
      .memoria-chat-messages-inner { display: flex; flex-direction: column; }
      .memoria-chat-message { margin-bottom: 8px; padding: 8px 12px; border-radius: 12px; max-width: 85%; width: fit-content; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      .user-message { background-color: var(--interactive-accent); color: var(--text-on-accent); align-self: flex-end; }
      .model-message { background-color: var(--background-secondary); align-self: flex-start; }
      .model-message.loading { color: var(--text-muted); font-style: italic; }
      .memoria-chat-input-form { display: flex; padding: 10px; border-top: 1px solid var(--background-modifier-border); background-color: var(--background-primary); flex-shrink: 0; align-items: flex-end; }
      .memoria-chat-input-textarea { flex-grow: 1; margin-right: 8px; resize: none; font-family: inherit; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); padding: 8px; min-height: 40px; max-height: 200px; overflow-y: auto; }
      .memoria-chat-send-button { align-self: flex-end; min-height: 40px; }
    `;

    const chatHeaderEl = container.createEl('div', { cls: 'memoria-chat-header' });

    // 新しいチャットボタン
    const newChatButton = chatHeaderEl.createEl('button', {
      text: 'New Chat',
      cls: 'mod-cta memoria-new-chat-button'
    });
    newChatButton.addEventListener('click', () => this.resetChat());

    // チャットを破棄ボタン
    const discardChatButton = chatHeaderEl.createEl('button', {
        text: 'Discard Chat',
        cls: 'mod-warning memoria-discard-chat-button'
    });
    discardChatButton.addEventListener('click', () => this.confirmAndDiscardChat());


    const messagesWrapperEl = container.createEl('div', { cls: 'memoria-chat-messages-wrapper' });
    this.chatMessagesEl = messagesWrapperEl.createEl('div', { cls: 'memoria-chat-messages-inner' });
    this.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');

    const inputFormEl = container.createEl('form', { cls: 'memoria-chat-input-form' });
    inputFormEl.addEventListener('submit', (event) => {
      event.preventDefault(); this.sendMessage();
    });

    this.inputEl = inputFormEl.createEl('textarea', {
      attr: { placeholder: 'メッセージを入力 (Shift+Enterで送信)', rows: 1 },
      cls: 'memoria-chat-input-textarea'
    });
    this.inputEl.addEventListener('input', () => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
    });
    this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault(); this.sendMessage();
      }
    });
    inputFormEl.createEl('button', {
      text: '送信', type: 'submit', cls: 'mod-cta memoria-chat-send-button'
    });

    if (!this.chainWithHistory) {
        new Notice('Geminiチャット機能が利用できません。設定（APIキー、モデル名）を確認してください。', 0);
    }
  }

  private async setupLogging() {
    const logDir = 'FullLog';
    try {
      if (!this.llmRoleName || this.llmRoleName === 'Assistant') {
        this.settings = this.plugin.settings;
        const systemPromptFromSettings = this.settings.systemPrompt || "You are a helpful assistant integrated into Obsidian.";
        this.llmRoleName = this.getLlmRoleName(systemPromptFromSettings);
      }

      const dirExists = await this.app.vault.adapter.exists(logDir);
      if (!dirExists) {
        await this.app.vault.createFolder(logDir);
        console.log(`[MemoriaChat] Created directory: ${logDir}`);
      }
      const timestamp = moment().format('YYYYMMDDHHmmss');
      this.logFilePath = `${logDir}/${timestamp}.md`;
      const currentDate = moment().format('YYYY-MM-DD HH:mm:ss');
      const initialLogContent = `---
title: undefined
date: ${currentDate}
type: full_log
summary_note: undefined
participants:
  - User
  - ${this.llmRoleName}
---
# 会話ログ: undefined
**日時**: ${currentDate}
---
`;
      const logFileExists = await this.app.vault.adapter.exists(this.logFilePath);
      if (!logFileExists) {
        await this.app.vault.create(this.logFilePath, initialLogContent);
        console.log(`[MemoriaChat] Created log file: ${this.logFilePath}`);
      } else {
        console.log(`[MemoriaChat] Log file already exists, not overwriting: ${this.logFilePath}`);
      }
    } catch (error: any) {
      console.error('[MemoriaChat] Error setting up logging:', error.message);
      new Notice('チャットログファイルの作成または確認に失敗しました。');
      this.logFilePath = null;
    }
  }

  async onClose() {
    // this.logFilePath = null; // ログファイルパスはセッション中維持されるべき
  }

  private async confirmAndDiscardChat() {
    if (!this.logFilePath) {
        new Notice('破棄するチャットログがありません。');
        // チャットログがない場合でも、UIとメモリ上の履歴はリセットする
        await this.resetChat(true); // 要約なしでリセット
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

  private async discardCurrentChatLogAndReset() {
    if (this.logFilePath) {
        const logFile = this.app.vault.getAbstractFileByPath(this.logFilePath);
        if (logFile instanceof TFile) {
            try {
                await this.app.vault.delete(logFile);
                new Notice(`チャットログファイル ${this.logFilePath} を削除しました。`);
                console.log(`[MemoriaChat] Deleted log file: ${this.logFilePath}`);
            } catch (error) {
                new Notice(`チャットログファイル ${this.logFilePath} の削除に失敗しました。`);
                console.error(`[MemoriaChat] Error deleting log file ${this.logFilePath}:`, error);
            }
        } else {
            // ログファイルが見つからない場合でも、ユーザーは破棄を意図しているので、UIリセットは行う
            new Notice(`チャットログファイル ${this.logFilePath} が見つかりませんでした。UIはリセットされます。`);
            console.warn(`[MemoriaChat] Log file not found for deletion: ${this.logFilePath}`);
        }
        this.logFilePath = null;
    } else {
        // ログファイルパスがない場合（最初のメッセージ送信前など）でも、UIとメモリ上の履歴はリセットする
        console.log('[MemoriaChat] No log file path set, resetting UI and history.');
    }
    await this.resetChat(true); // 要約をスキップしてチャットをリセット
    new Notice('現在のチャットが破棄され、新しいチャットが開始されました。');
  }


  private async resetChat(skipSummary: boolean = false) {
    const previousLogPath = this.logFilePath;
    const previousLlmRoleName = this.llmRoleName;

    // 新しいログファイルパスをnullに初期化。最初のメッセージ送信時に作成される。
    this.logFilePath = null;

    if (this.chatMessagesEl) {
      this.chatMessagesEl.empty();
    }
    this.messageHistory = new ChatMessageHistory();
    this.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
    this.scrollToBottom();

    if (this.inputEl) {
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.inputEl.focus();
    }

    console.log('[MemoriaChat] Chat has been reset.'); // ログファイル作成のメッセージは削除
    if (!skipSummary) {
        new Notice('新しいチャットが開始されました。'); // ログファイル作成のメッセージは削除
    }


    if (!skipSummary && previousLogPath && previousLlmRoleName) {
      new Notice(`前のチャットの要約をバックグラウンドで生成開始します: ${previousLogPath}`);
      this.summaryGenerator.generateSummary(previousLogPath, previousLlmRoleName)
        .then(() => {
            console.log(`[MemoriaChat] Summary generation completed for ${previousLogPath}`);
        })
        .catch(error => {
            console.error(`[MemoriaChat] Summary generation failed for ${previousLogPath}:`, error);
            new Notice(`前のチャット (${previousLogPath}) の要約作成に失敗しました。`);
        });
    } else if (skipSummary) {
        console.log('[MemoriaChat] Summary generation skipped for previous chat.');
    }
  }

  private appendMessage(message: string, type: 'user' | 'model' | 'loading') {
    const messageEl = this.chatMessagesEl.createEl('div', {
        cls: `memoria-chat-message ${type}-message ${type === 'loading' ? 'loading' : ''}`
    });
    messageEl.setText(message);
    this.scrollToBottom();
    return messageEl;
  }

  appendUserMessage(message: string) { this.appendMessage(message, 'user'); }
  appendModelMessage(message: string) { this.appendMessage(message, 'model'); }

  scrollToBottom() {
    const wrapper = this.chatMessagesEl.parentElement;
    if (wrapper) {
      setTimeout(() => { wrapper.scrollTop = wrapper.scrollHeight; }, 50);
    }
  }

  async sendMessage() {
    const rawMessageContent = this.inputEl.value;
    const trimmedMessageContent = rawMessageContent.trim();

    if (!trimmedMessageContent) {
      if (rawMessageContent.length > 0) new Notice("メッセージが空白です。送信は行いません。");
      this.inputEl.value = ''; this.inputEl.style.height = 'auto'; this.inputEl.focus();
      return;
    }

    // 最初のユーザーメッセージ送信時にログファイルを作成
    if (!this.logFilePath) {
        await this.setupLogging();
        if (!this.logFilePath) { // setupLoggingが失敗した場合
            this.appendModelMessage('エラー: ログファイルの作成に失敗したため、メッセージを送信できません。');
            new Notice('ログファイルの作成に失敗しました。');
            return;
        }
    }

    this.appendUserMessage(trimmedMessageContent);

    if (this.logFilePath) {
      const file = this.app.vault.getFileByPath(this.logFilePath);
      if (file instanceof TFile) {
        const userLogEntry = `**User**: ${trimmedMessageContent}\n`;
        try {
          await this.app.vault.append(file, userLogEntry);
        } catch (error) {
          console.error('[MemoriaChat] Error appending user message to log:', error);
        }
      } else {
          console.error("[MemoriaChat] Log file not found for appending user message:", this.logFilePath);
      }
    }

    this.inputEl.value = ''; this.inputEl.style.height = 'auto'; this.inputEl.focus();

    if (!this.chainWithHistory) {
      this.appendModelMessage('エラー: チャットチェーンが初期化されていません。プラグイン設定を確認してください。');
      new Notice('チャット機能が利用できません。設定を確認してください。');
      this.initializeChatModel();
      if(!this.chainWithHistory) return;
    }

    const loadingMessageEl = this.appendMessage('応答を待っています...', 'loading');

    try {
      const response = await this.chainWithHistory.invoke(
        { input: trimmedMessageContent },
        { configurable: { sessionId: "obsidian-memoria-session" } }
      );
      loadingMessageEl.remove();
      let responseText = '';

      if (response && typeof response.content === 'string') {
        responseText = response.content;
      } else if (response && Array.isArray(response.content) && response.content.length > 0 && typeof response.content[0] === 'object' && response.content[0] !== null && 'text' in response.content[0]) {
        responseText = (response.content[0] as any).text;
      } else {
        console.error('[MemoriaChat] Invalid response format:', response);
        responseText = 'エラー: 予期しない形式の応答がありました。';
      }
      this.appendModelMessage(responseText);

      if (this.logFilePath && responseText) {
        const file = this.app.vault.getFileByPath(this.logFilePath);
        if (file instanceof TFile) {
            const modelLogEntry = `**${this.llmRoleName}**: ${responseText}\n`;
            try {
                await this.app.vault.append(file, modelLogEntry);
            } catch (error) {
                console.error('[MemoriaChat] Error appending model response to log:', error);
            }
        } else {
            console.error("[MemoriaChat] Log file not found for appending model response:", this.logFilePath);
        }
      }

    } catch (error: any) {
      console.error('[MemoriaChat] Error sending message:', error.message, error.stack);
      loadingMessageEl.remove();
      let errorMessage = 'エラー: メッセージの送信中に問題が発生しました。';
      if (error.message) errorMessage += `\n詳細: ${error.message}`;
      this.appendModelMessage(errorMessage);
      new Notice(`チャットエラー: ${error.message || '不明なエラー'}`);

      if (this.logFilePath) {
        const file = this.app.vault.getFileByPath(this.logFilePath);
        if (file instanceof TFile) {
            const errorLogEntry = `**${this.llmRoleName}**: (エラー発生) ${error.message || '不明なエラー'}\n`;
            try {
                await this.app.vault.append(file, errorLogEntry);
            } catch (logError) {
                console.error('[MemoriaChat] Error appending error to log:', logError);
            }
        } else {
             console.error("[MemoriaChat] Log file not found for appending error message:", this.logFilePath);
        }
      }
    } finally {
      this.scrollToBottom();
    }
  }
}
