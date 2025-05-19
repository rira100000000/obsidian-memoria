// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import ObsidianMemoria from '../../main'; // main.ts のパスはプロジェクト構成に合わせてください
import { GeminiPluginSettings } from '../settings'; // settings.ts のパスも同様

// LangChain.jsからのインポート
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages"; // SystemMessage もインポート
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
  // private promptTemplate: ChatPromptTemplate | null = null; // promptTemplateはinitializeChatModel内でローカルに扱う

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.initializeChatModel(); // コンストラクタで初期化
  }

  private initializeChatModel() {
    // this.promptTemplate = null; // ローカル変数として扱うため、クラスプロパティからは削除

    // 設定を最新の状態に更新
    this.settings = this.plugin.settings;
    const systemPromptFromSettings = this.settings.systemPrompt || "You are a helpful assistant integrated into Obsidian."; // 設定からシステムプロンプトを取得、なければデフォルト

    if (this.settings.geminiApiKey && this.settings.geminiModel) {
      try {
        this.chatModel = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: this.settings.geminiModel,
        });

        // プロンプトテンプレートの定義
        // SystemMessageの内容を設定から読み込んだものに置き換える
        const prompt = ChatPromptTemplate.fromMessages([
          new SystemMessage(systemPromptFromSettings), // 設定されたシステムプロンプトを使用
          new MessagesPlaceholder("history"),
          ["human", "{input}"], // ユーザー入力を埋め込む
        ]);
        // this.promptTemplate = prompt; // ローカル変数として扱う

        // プロンプトとモデルを結合したチェーン
        const chain = prompt.pipe(this.chatModel);

        // RunnableWithMessageHistory を初期化
        this.chainWithHistory = new RunnableWithMessageHistory({
            runnable: chain,
            getMessageHistory: (_sessionId) => this.messageHistory,
            inputMessagesKey: "input",
            historyMessagesKey: "history",
        });
        console.log('[MemoriaChat] ChatGoogleGenerativeAI model and chain with history initialized successfully with system prompt:', systemPromptFromSettings);
      } catch (error: any) {
        console.error('[MemoriaChat] Failed to initialize ChatGoogleGenerativeAI model or chain:', error.message);
        new Notice('Geminiモデルまたはチャットチェーンの初期化に失敗しました。');
        this.chatModel = null;
        this.chainWithHistory = null;
        // this.promptTemplate = null;
      }
    } else {
      console.log('[MemoriaChat] API key or model name not set. Chat model not initialized.');
      this.chatModel = null;
      this.chainWithHistory = null;
      // this.promptTemplate = null;
    }
  }

  // 設定が変更されたときに呼び出されるメソッド
  onSettingsChanged() {
    // this.settings = this.plugin.settings; // initializeChatModel内で最新の設定を取得するため、ここでは不要
    this.initializeChatModel(); // 設定が変更されたらチャットモデルを再初期化
    console.log('[MemoriaChat] Settings changed, chat model re-initialized.');
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
    // onOpen時にも最新の設定で初期化を試みる（特に初回起動時など）
    this.settings = this.plugin.settings; // 最新の設定を読み込み
    this.initializeChatModel(); // チャットモデルを初期化

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

    // 入力に応じてテキストエリアの高さを自動調整
    this.inputEl.addEventListener('input', () => {
        this.inputEl.style.height = 'auto'; // 一旦高さをリセット
        this.inputEl.style.height = `${this.inputEl.scrollHeight}px`; // スクロールハイトに合わせて高さを設定
    });

    this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        if (event.shiftKey) { // Shift + Enter の場合のみ送信
          event.preventDefault(); // 通常のEnterでの改行を防ぐ
          this.sendMessage();
        }
        // Shiftキーが押されていないEnterの場合は、テキストエリア内で改行される (デフォルト動作)
      }
    });

    // 送信ボタン
    inputFormEl.createEl('button', {
      text: '送信',
      type: 'submit',
      cls: 'mod-cta memoria-chat-send-button'
    });

    // 初期化チェック (onOpen時にも行うことで、プラグインロード後の最初のビュー表示で確実にチェック)
    if (!this.chainWithHistory) {
        // initializeChatModelは既にonOpenの冒頭で呼ばれているので、ここでは再呼び出しせず、
        // それでも初期化されていなければ通知を出す
        new Notice('Geminiチャット機能が利用できません。設定（APIキー、モデル名）を確認してください。', 0); // 0で通知が消えないようにする
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

    if (!trimmedMessageContent) {
      if (rawMessageContent.length > 0) {
        new Notice("メッセージが空白です。送信は行いません。");
      }
      this.inputEl.value = ''; // 空白のみでも入力欄はクリア
      this.inputEl.style.height = 'auto'; // 高さをリセット
      this.inputEl.focus();
      return;
    }

    this.appendUserMessage(trimmedMessageContent);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto'; // 送信後も高さをリセット
    this.inputEl.focus();

    // sendMessageが呼ばれる前にinitializeChatModelが呼ばれていることを期待。
    // chainWithHistoryがなければ、エラーメッセージを表示して処理を中断。
    if (!this.chainWithHistory) { // promptTemplateのチェックは不要（chainWithHistoryが作られていればpromptもあるはず）
      this.appendModelMessage('エラー: チャットチェーンが初期化されていません。プラグイン設定（APIキー、モデル名）を確認してください。');
      new Notice('チャット機能が利用できません。APIキーとモデル名を設定し、ビューを再読み込みするか、Obsidianを再起動してみてください。');
      // 再度初期化を試みる (ユーザーが設定を変更した直後の場合など)
      this.initializeChatModel();
      if(!this.chainWithHistory) return; // それでもダメなら中断
    }

    const loadingMessageEl = this.appendMessage('応答を待っています...', 'loading');

    try {
      // LangChainのチェーンを呼び出し
      const response = await this.chainWithHistory.invoke(
        { input: trimmedMessageContent }, // ChatPromptTemplateで定義した "input" キーにユーザーメッセージを渡す
        { configurable: { sessionId: "obsidian-memoria-session" } } // sessionId は固定または動的に設定
      );

      loadingMessageEl.remove(); // ローディングメッセージを削除

      // 応答の処理 (LangChainからの応答形式に合わせて調整が必要な場合がある)
      if (response && typeof response.content === 'string') {
        this.appendModelMessage(response.content);
      } else if (response && Array.isArray(response.content) && response.content.length > 0 && typeof response.content[0] === 'object' && response.content[0] !== null && 'text' in response.content[0]) {
        // 一部のモデルや設定では、contentがオブジェクトの配列で返ってくることがあるため対応
        this.appendModelMessage((response.content[0] as any).text);
      }
      else {
        console.error('[MemoriaChat] Invalid or unexpected response format from LangChain chain:', response);
        this.appendModelMessage('エラー: 予期しない形式の応答がありました。コンソールログを確認してください。');
      }

    } catch (error: any) {
      console.error('[MemoriaChat] Error sending message via LangChain:', error.message, error.stack); // エラー時にはスタックトレースも出力
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
