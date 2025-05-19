// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
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
  private promptTemplate: ChatPromptTemplate | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.initializeChatModel();
  }

  private initializeChatModel() {
    this.promptTemplate = null;

    if (this.settings.geminiApiKey && this.settings.geminiModel) {
      try {
        this.chatModel = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: this.settings.geminiModel,
        });

        // プロンプトテンプレートの定義
        const prompt = ChatPromptTemplate.fromMessages([
          ["system", "You are a helpful assistant integrated into Obsidian."],
          new MessagesPlaceholder("history"),
          ["human", "{input}"], // ユーザー入力を埋め込む
        ]);
        this.promptTemplate = prompt;

        // プロンプトとモデルを結合したチェーン
        const chain = this.promptTemplate.pipe(this.chatModel);

        // RunnableWithMessageHistory を初期化
        this.chainWithHistory = new RunnableWithMessageHistory({
            runnable: chain,
            getMessageHistory: (_sessionId) => this.messageHistory, // セッションIDごとに履歴を管理する場合は適宜変更
            inputMessagesKey: "input",
            historyMessagesKey: "history",
        });
        // console.log('[MemoriaChat] ChatGoogleGenerativeAI model and chain with history initialized successfully.');
      } catch (error: any) {
        console.error('[MemoriaChat] Failed to initialize ChatGoogleGenerativeAI model or chain:', error.message);
        new Notice('Geminiモデルまたはチャットチェーンの初期化に失敗しました。');
        this.chatModel = null;
        this.chainWithHistory = null;
        this.promptTemplate = null;
      }
    } else {
      // console.log('[MemoriaChat] API key or model name not set. Chat model not initialized.');
      this.chatModel = null;
      this.chainWithHistory = null;
      this.promptTemplate = null;
    }
  }

  onSettingsChanged() {
    this.settings = this.plugin.settings;
    this.initializeChatModel();
    // console.log('[MemoriaChat] Settings changed, chat model re-initialized.');
  }

  getViewType() {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Memoria Chat';
  }

  getIcon() {
    return 'messages-square'; // Obsidianのアイコン名
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('memoria-chat-view-container');

    // スタイル設定
    const styleEl = container.createEl('style');
    styleEl.textContent = `
      .memoria-chat-view-container { display: flex; flex-direction: column; height: 100%; }
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

    // メッセージ表示エリア
    const messagesWrapperEl = container.createEl('div', { cls: 'memoria-chat-messages-wrapper' });
    this.chatMessagesEl = messagesWrapperEl.createEl('div', { cls: 'memoria-chat-messages-inner' });
    this.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');

    // 入力フォーム
    const inputFormEl = container.createEl('form', { cls: 'memoria-chat-input-form' });
    inputFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      this.sendMessage();
    });

    this.inputEl = inputFormEl.createEl('textarea', {
      attr: {
        placeholder: 'メッセージを入力 (Shift+Enterで送信)',
        rows: 1,
      },
      cls: 'memoria-chat-input-textarea'
    });

    this.inputEl.addEventListener('input', () => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
    });

    this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        if (event.shiftKey) {
          event.preventDefault(); // 通常のEnterでの改行を防ぐ
          this.sendMessage();
        }
      }
    });

    // 送信ボタン
    inputFormEl.createEl('button', {
      text: '送信',
      type: 'submit',
      cls: 'mod-cta memoria-chat-send-button'
    });

    // 初期化チェック
    if (!this.chainWithHistory) {
        this.initializeChatModel();
        if(!this.chainWithHistory){
            new Notice('Geminiチャット機能が利用できません。設定を確認してください。', 0);
        }
    }
  }

  async onClose() {
    // クリーンアップ処理 (もしあれば)
  }

  private appendMessage(message: string, type: 'user' | 'model' | 'loading') {
    const messageEl = this.chatMessagesEl.createEl('div', {
        cls: `memoria-chat-message ${type}-message ${type === 'loading' ? 'loading' : ''}`
    });
    messageEl.setText(message);
    this.scrollToBottom();
    return messageEl;
  }

  appendUserMessage(message: string) {
    this.appendMessage(message, 'user');
  }

  appendModelMessage(message: string) {
    this.appendMessage(message, 'model');
  }

  scrollToBottom() {
    const wrapper = this.chatMessagesEl.parentElement;
    if (wrapper) {
      setTimeout(() => {
        wrapper.scrollTop = wrapper.scrollHeight;
      }, 50);
    }
  }

  async sendMessage() {
    const rawMessageContent = this.inputEl.value;
    const trimmedMessageContent = rawMessageContent.trim();

    // console.log(`[MemoriaChat] sendMessage called. Raw input: "${rawMessageContent}", Trimmed input: "${trimmedMessageContent}"`);

    if (!trimmedMessageContent) {
      if (rawMessageContent.length > 0) {
        new Notice("メッセージが空白です。送信は行いません。");
        // console.log('[MemoriaChat] Message is whitespace only. Aborting send.');
      } else {
        //  console.log('[MemoriaChat] Message is empty. Aborting send.');
      }
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.inputEl.focus();
      return;
    }

    this.appendUserMessage(trimmedMessageContent);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.inputEl.focus();

    if (!this.chainWithHistory || !this.promptTemplate) {
      this.appendModelMessage('エラー: チャットチェーンまたはプロンプトが初期化されていません。プラグイン設定を確認してください。');
      new Notice('チャット機能が利用できません。APIキーとモデル名を設定してください。');
      this.initializeChatModel();
      if(!this.chainWithHistory || !this.promptTemplate) return;
    }

    const loadingMessageEl = this.appendMessage('応答を待っています...', 'loading');

    try {
      // console.log('[MemoriaChat] Sending to LangChain chain:', { input: trimmedMessageContent });
      // const historyBeforeInvoke = await this.messageHistory.getMessages();
      // console.log('[MemoriaChat] Current message history (before invoke):', JSON.stringify(historyBeforeInvoke.map(m => ({type: m._getType(), content: m.content})), null, 2));

      // デバッグ用の詳細なログは削除またはコメントアウト
      // console.log('[MemoriaChat] DEBUG: About to check this.promptTemplate.');
      // if (this.promptTemplate) {
      //   console.log('[MemoriaChat] DEBUG: this.promptTemplate exists. Type:', typeof this.promptTemplate, 'Instance of ChatPromptTemplate:', this.promptTemplate instanceof ChatPromptTemplate);
      //   try {
      //     console.log('[MemoriaChat] DEBUG: Attempting to call this.promptTemplate.formatMessages().');
      //     const formattedMessagesForDebug = await this.promptTemplate.formatMessages({
      //       input: trimmedMessageContent,
      //       history: historyBeforeInvoke
      //     });
      //     console.log('[MemoriaChat] Manually formatted messages (for debug before invoke):', JSON.stringify(formattedMessagesForDebug.map(m => ({type: m._getType(), content: m.content})), null, 2));
      //   } catch (e: any) {
      //     console.error('[MemoriaChat] Error formatting messages for debug:', e.message, e.stack, e);
      //   }
      // } else {
      //   console.log('[MemoriaChat] DEBUG: this.promptTemplate is NULL or UNDEFINED.');
      // }
      // console.log('[MemoriaChat] DEBUG: Finished checking this.promptTemplate.');


      const response = await this.chainWithHistory.invoke(
        { input: trimmedMessageContent },
        { configurable: { sessionId: "obsidian-memoria-session" } } // sessionId は固定で良いか、動的にするか検討
      );

      // const historyAfterInvoke = await this.messageHistory.getMessages();
      // console.log('[MemoriaChat] Current message history (after invoke):', JSON.stringify(historyAfterInvoke.map(m => ({type: m._getType(), content: m.content})), null, 2));
      // console.log('[MemoriaChat] Received response from LangChain chain:', response);

      loadingMessageEl.remove();
      if (response && typeof response.content === 'string') {
        this.appendModelMessage(response.content);
      } else if (response && Array.isArray(response.content) && response.content.length > 0 && typeof response.content[0] === 'object' && 'text' in response.content[0]) {
        this.appendModelMessage((response.content[0] as any).text);
      } else {
        console.error('[MemoriaChat] Invalid or unexpected response format from LangChain chain:', response);
        this.appendModelMessage('エラー: 予期しない形式の応答がありました。');
      }

    } catch (error: any) {
      console.error('[MemoriaChat] Error sending message via LangChain:', error.message); // スタックトレースは開発時には有用だが、本番ではメッセージのみでも可
      loadingMessageEl.remove();
      let errorMessage = 'エラー: メッセージの送信中に問題が発生しました。';
      if (error.message) {
        errorMessage += `\n詳細: ${error.message}`;
      }
      this.appendModelMessage(errorMessage);
      new Notice(`チャットエラー: ${error.message || '不明なエラー'}`);
    } finally {
      this.scrollToBottom();
    }
  }
}
