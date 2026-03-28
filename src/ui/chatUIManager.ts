// src/ui/chatUIManager.ts
import { App, Modal, Setting } from 'obsidian';

/**
 * デバッグログのエントリ
 */
interface DebugLogEntry {
  timestamp: string;
  category: string;
  message: string;
  data?: string;
}

/**
 * ChatUIManagerクラス
 * ChatViewのUI要素の生成、更新、管理を担当します。
 */
export class ChatUIManager {
  public chatMessagesEl!: HTMLElement; // チャットメッセージが表示される内部コンテナ
  public inputEl!: HTMLTextAreaElement; // ユーザー入力用のテキストエリア

  private containerEl: HTMLElement; // ChatViewのメインコンテナの直接の子 (通常は .view-content)
  private onSendMessage: () => Promise<void>; // 送信ボタンクリック時のコールバック
  private onResetChat: () => Promise<void>; // 新規チャットボタンクリック時のコールバック
  private onDiscardChat: () => Promise<void>; // 破棄ボタンクリック時のコールバック

  // ステータスインジケーター
  private statusIndicatorEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;

  // デバッグログパネル
  private debugPanelEl: HTMLElement | null = null;
  private debugLogContentEl: HTMLElement | null = null;
  private debugToggleButton: HTMLElement | null = null;
  private debugPanelVisible = false;
  private debugLogEntries: DebugLogEntry[] = [];
  public enableDebugLog = false;

  constructor(
    containerEl: HTMLElement,
    onSendMessage: () => Promise<void>,
    onResetChat: () => Promise<void>,
    onDiscardChat: () => Promise<void>
  ) {
    this.containerEl = containerEl;
    this.onSendMessage = onSendMessage;
    this.onResetChat = onResetChat;
    this.onDiscardChat = onDiscardChat;
    this.setupBaseUI();
  }

  /**
   * チャットウィンドウの基本的なUI構造をセットアップします。
   * ヘッダー、メッセージエリア、入力フォームを含みます。
   * スタイルは外部のstyles.cssで定義されることを前提とします。
   */
  private setupBaseUI(): void {
    this.containerEl.empty();
    this.containerEl.addClass('memoria-chat-view-container');

    // スタイル定義は外部のstyles.cssに移行

    // ヘッダー（ボタン類）
    const chatHeaderEl = this.containerEl.createEl('div', { cls: 'memoria-chat-header' });

    const newChatButton = chatHeaderEl.createEl('button', {
      text: 'New Chat',
      cls: 'mod-cta memoria-new-chat-button'
    });
    newChatButton.addEventListener('click', this.onResetChat);

    const discardChatButton = chatHeaderEl.createEl('button', {
        text: 'Discard Chat',
        cls: 'mod-warning memoria-discard-chat-button'
    });
    discardChatButton.addEventListener('click', this.onDiscardChat);

    this.debugToggleButton = chatHeaderEl.createEl('button', {
        text: 'Debug',
        cls: 'memoria-debug-toggle-button'
    });
    this.debugToggleButton.addEventListener('click', () => this.toggleDebugPanel());
    this.debugToggleButton.style.display = 'none'; // デフォルト非表示、enableDebugLogで制御

    // チャットメッセージ表示エリア
    const messagesWrapperEl = this.containerEl.createEl('div', { cls: 'memoria-chat-messages-wrapper' });
    this.chatMessagesEl = messagesWrapperEl.createEl('div', { cls: 'memoria-chat-messages-inner' });

    // ステータスインジケーター（メッセージエリア内、通常は非表示）
    this.statusIndicatorEl = this.containerEl.createEl('div', { cls: 'memoria-status-indicator' });
    this.statusIndicatorEl.style.display = 'none';
    const spinnerEl = this.statusIndicatorEl.createEl('span', { cls: 'memoria-spinner' });
    this.statusTextEl = this.statusIndicatorEl.createEl('span', { cls: 'memoria-status-text' });

    // デバッグログパネル
    this.debugPanelEl = this.containerEl.createEl('div', { cls: 'memoria-debug-panel' });
    this.debugPanelEl.style.display = 'none';
    const debugHeaderEl = this.debugPanelEl.createEl('div', { cls: 'memoria-debug-header' });
    debugHeaderEl.createEl('span', { text: 'Debug Log', cls: 'memoria-debug-title' });
    const clearDebugBtn = debugHeaderEl.createEl('button', { text: 'Clear', cls: 'memoria-debug-clear-button' });
    clearDebugBtn.addEventListener('click', () => this.clearDebugLog());
    this.debugLogContentEl = this.debugPanelEl.createEl('div', { cls: 'memoria-debug-content' });

    // 入力フォーム
    const inputFormEl = this.containerEl.createEl('form', { cls: 'memoria-chat-input-form' });
    inputFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      this.onSendMessage();
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
          event.preventDefault();
          this.onSendMessage();
      }
    });
    inputFormEl.createEl('button', {
      text: '送信', type: 'submit', cls: 'mod-cta memoria-chat-send-button'
    });
  }

  /**
   * メッセージをチャットウィンドウに追加します。
   * @param {string} message 表示するメッセージテキスト。
   * @param {'user' | 'model' | 'loading'} type メッセージのタイプ。
   * @returns {HTMLElement} 追加されたメッセージ要素。
   */
  public appendMessage(message: string, type: 'user' | 'model' | 'loading'): HTMLElement {
    const messageEl = this.chatMessagesEl.createEl('div', {
        cls: `memoria-chat-message ${type}-message ${type === 'loading' ? 'loading' : ''}`
    });
    messageEl.setText(message); // XSS対策のためtextContentではなくsetTextを使用
    this.scrollToBottom();
    return messageEl;
  }

  /**
   * ユーザーメッセージをチャットウィンドウに追加します。
   * @param {string} message 表示するメッセージテキスト。
   */
  public appendUserMessage(message: string): void {
    this.appendMessage(message, 'user');
  }

  /**
   * モデル（AI）メッセージをチャットウィンドウに追加します。
   * @param {string} message 表示するメッセージテキスト。
   */
  public appendModelMessage(message: string): void {
    this.appendMessage(message, 'model');
  }

  /**
   * チャットメッセージ表示エリアをクリアします。
   */
  public clearMessages(): void {
    if (this.chatMessagesEl) {
      this.chatMessagesEl.empty();
    }
  }

  /**
   * 入力フィールドをクリアし、高さをリセットしてフォーカスします。
   */
  public resetInputField(): void {
    if (this.inputEl) {
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.inputEl.focus();
    }
  }

  /**
   * チャットの最下部へスクロールします。
   */
  public scrollToBottom(): void {
    const wrapper = this.chatMessagesEl.parentElement; // .memoria-chat-messages-wrapper
    if (wrapper) {
      // 少し遅延させることで、DOMのレンダリング完了後にスクロールする
      setTimeout(() => { wrapper.scrollTop = wrapper.scrollHeight; }, 50);
    }
  }

  /**
   * 入力テキストエリアから現在のテキストを取得します。
   * @returns {string} 入力されたテキスト。
   */
  public getInputText(): string {
    return this.inputEl ? this.inputEl.value : '';
  }

  // --- ステータスインジケーター ---

  /**
   * ステータスインジケーターを表示し、フェーズテキストを設定します。
   */
  public showStatus(phase: string): void {
    if (this.statusIndicatorEl && this.statusTextEl) {
      this.statusTextEl.setText(phase);
      this.statusIndicatorEl.style.display = 'flex';
    }
  }

  /**
   * ステータスインジケーターを非表示にします。
   */
  public hideStatus(): void {
    if (this.statusIndicatorEl) {
      this.statusIndicatorEl.style.display = 'none';
    }
  }

  // --- デバッグログパネル ---

  /**
   * デバッグモードの有効/無効を設定します。
   */
  public setDebugMode(enabled: boolean): void {
    this.enableDebugLog = enabled;
    if (this.debugToggleButton) {
      this.debugToggleButton.style.display = enabled ? '' : 'none';
    }
    if (!enabled && this.debugPanelEl) {
      this.debugPanelEl.style.display = 'none';
      this.debugPanelVisible = false;
    }
  }

  /**
   * デバッグパネルの表示/非表示を切り替えます。
   */
  private toggleDebugPanel(): void {
    this.debugPanelVisible = !this.debugPanelVisible;
    if (this.debugPanelEl) {
      this.debugPanelEl.style.display = this.debugPanelVisible ? 'flex' : 'none';
    }
    if (this.debugToggleButton) {
      this.debugToggleButton.classList.toggle('is-active', this.debugPanelVisible);
    }
  }

  /**
   * デバッグログにエントリを追加します。
   */
  public addDebugLogEntry(category: string, message: string, data?: string): void {
    if (!this.enableDebugLog) return;

    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    const entry: DebugLogEntry = { timestamp, category, message, data };
    this.debugLogEntries.push(entry);

    if (this.debugLogContentEl) {
      const entryEl = this.debugLogContentEl.createEl('div', { cls: 'memoria-debug-entry' });
      const headerLine = entryEl.createEl('div', { cls: 'memoria-debug-entry-header' });
      headerLine.createEl('span', { text: timestamp, cls: 'memoria-debug-timestamp' });
      headerLine.createEl('span', { text: category, cls: 'memoria-debug-category' });
      entryEl.createEl('div', { text: message, cls: 'memoria-debug-message' });
      if (data) {
        const dataEl = entryEl.createEl('div', { cls: 'memoria-debug-data' });
        dataEl.createEl('pre', { text: data });
      }
      // 自動スクロール
      this.debugLogContentEl.scrollTop = this.debugLogContentEl.scrollHeight;
    }
  }

  /**
   * 新しいメッセージ送信時にデバッグログにセパレーターを追加します。
   */
  public addDebugLogSeparator(userMessage: string): void {
    if (!this.enableDebugLog || !this.debugLogContentEl) return;

    const separatorEl = this.debugLogContentEl.createEl('div', { cls: 'memoria-debug-separator' });
    separatorEl.createEl('span', { text: `── User: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''} ──` });
  }

  /**
   * デバッグログをクリアします。
   */
  private clearDebugLog(): void {
    this.debugLogEntries = [];
    if (this.debugLogContentEl) {
      this.debugLogContentEl.empty();
    }
  }
}

/**
 * 確認モーダルクラス
 * ChatView内でのみ使用するため、ここに配置します。
 * より汎用的にする場合は、別のファイルに移動することも検討できます。
 */
export class ConfirmationModal extends Modal {
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
