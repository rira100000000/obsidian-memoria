// src/ui/chatUIManager.ts
import { App, Modal, Setting } from 'obsidian';

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


    // チャットメッセージ表示エリア
    const messagesWrapperEl = this.containerEl.createEl('div', { cls: 'memoria-chat-messages-wrapper' });
    this.chatMessagesEl = messagesWrapperEl.createEl('div', { cls: 'memoria-chat-messages-inner' });

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
