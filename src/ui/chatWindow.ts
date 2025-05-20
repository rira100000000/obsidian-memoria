// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice, moment, TFile } from 'obsidian'; // moment と TFile をObsidianからインポート
import ObsidianMemoria from '../../main'; // main.ts のパスはプロジェクト構成に合わせてください
import { GeminiPluginSettings } from '../settings'; // settings.ts のパスも同様

// LangChain.jsからのインポート
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";

export const CHAT_VIEW_TYPE = 'obsidian-memoria-chat-view';

export class ChatView extends ItemView {
  plugin: ObsidianMemoria;
  settings: GeminiPluginSettings;
  chatMessagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;

  private messageHistory = new ChatMessageHistory();
  private chatModel: ChatGoogleGenerativeAI | null = null;
  private chainWithHistory: RunnableWithMessageHistory<Record<string, any>, BaseMessage> | null = null;

  private logFilePath: string | null = null; // ログファイルのパスを保持
  private llmRoleName = 'Assistant'; // LLMの役割名のデフォルト (型推論に任せる)

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  private getLlmRoleName(systemPrompt: string): string {
    if (!systemPrompt) return 'Assistant';
    let match;
    // "named <Name>" パターン (例: "You are a helpful assistant named HAL.")
    match = systemPrompt.match(/named\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    // "Your name is <Name>" パターン
    match = systemPrompt.match(/Your name is\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    // "Your role is <Role>" パターン
    match = systemPrompt.match(/Your role is\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    // "You are a <Role Name>." パターン (より具体的)
    // "helpful assistant" や "AI assistant" のような一般的なものは避ける
    match = systemPrompt.match(/^You are (?:a|an)\s+([\w\s-]+?)(?:\.|$)/i);
    if (match && match[1]) {
        const role = match[1].trim();
        const lowerRole = role.toLowerCase();
        if (lowerRole === 'helpful assistant' || lowerRole === 'ai assistant' || lowerRole === 'assistant') {
            return 'Assistant';
        }
        return role;
    }
    return 'Assistant'; // デフォルト
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
    console.log('[MemoriaChat] Settings changed, chat model re-initialized.');
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return 'Memoria Chat'; }
  getIcon() { return 'messages-square'; }

  async onOpen() {
    this.settings = this.plugin.settings;
    this.initializeChatModel(); // Initialize model and llmRoleName
    await this.setupLogging();   // Then setup logging which might use llmRoleName

    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('memoria-chat-view-container');

    const styleEl = container.createEl('style');
    styleEl.textContent = `
      .memoria-chat-view-container { display: flex; flex-direction: column; height: 100%; }
      .memoria-chat-header { display: flex; justify-content: flex-end; padding: 8px 10px; border-bottom: 1px solid var(--background-modifier-border); background-color: var(--background-primary); flex-shrink: 0; }
      .memoria-new-chat-button { /* new chat button styles */ }
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
    const newChatButton = chatHeaderEl.createEl('button', {
      text: 'new chat',
      cls: 'mod-cta memoria-new-chat-button'
    });
    newChatButton.addEventListener('click', () => this.resetChat());

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
      // Ensure llmRoleName is set before it's used in initialLogContent
      if (!this.llmRoleName) {
        this.settings = this.plugin.settings; // Ensure settings are current
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
      await this.app.vault.create(this.logFilePath, initialLogContent);
      console.log(`[MemoriaChat] Created log file: ${this.logFilePath}`);
    } catch (error) {
      console.error('[MemoriaChat] Error setting up logging:', error);
      new Notice('チャットログファイルの作成に失敗しました。');
      this.logFilePath = null;
    }
  }

  async onClose() {
    this.logFilePath = null;
  }

  private async resetChat() {
    // 1. Create a new log file for the new chat session
    // This will also update this.llmRoleName if it wasn't set, via setupLogging's internal check.
    await this.setupLogging(); 

    // 2. Clear the UI
    if (this.chatMessagesEl) {
      this.chatMessagesEl.empty();
    }

    // 3. Reset in-memory message history
    this.messageHistory = new ChatMessageHistory();
    // chainWithHistory will use the new messageHistory instance automatically

    // 4. Display initial welcome message in UI
    this.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
    
    // 5. Scroll to bottom
    this.scrollToBottom();

    // 6. Clear and focus input field
    if (this.inputEl) {
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto'; // Reset textarea height
      this.inputEl.focus();
    }

    console.log('[MemoriaChat] Chat has been reset. New log file created at:', this.logFilePath);
    new Notice('新しいチャットが開始されました。新しいログファイルが作成されました。');
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
      this.initializeChatModel(); // Attempt to re-initialize
      if(!this.chainWithHistory) return; // If still not initialized, stop
    }

    const loadingMessageEl = this.appendMessage('応答を待っています...', 'loading');

    try {
      const response = await this.chainWithHistory.invoke(
        { input: trimmedMessageContent },
        { configurable: { sessionId: "obsidian-memoria-session" } } // Ensure sessionId is consistent
      );
      loadingMessageEl.remove();
      let responseText = '';

      if (response && typeof response.content === 'string') {
        responseText = response.content;
      } else if (response && Array.isArray(response.content) && response.content.length > 0 && typeof response.content[0] === 'object' && response.content[0] !== null && 'text' in response.content[0]) {
        // Handle cases where content might be an array of objects with a text property
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
