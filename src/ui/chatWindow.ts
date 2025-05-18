// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, App, Notice, Platform } from 'obsidian';
import ObsidianMemoria from '../../main';
import { GeminiPluginSettings } from '../settings';

export const CHAT_VIEW_TYPE = 'obsidian-memoria-chat-view';

export class ChatView extends ItemView {
  plugin: ObsidianMemoria;
  settings: GeminiPluginSettings;
  chatMessagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  getViewType() {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Memoria Chat';
  }

  getIcon() {
    return 'messages-square';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('memoria-chat-view-container');

    const styleEl = container.createEl('style');
    styleEl.textContent = `
      .memoria-chat-view-container { display: flex; flex-direction: column; height: 100%; }
      .memoria-chat-messages-wrapper { flex-grow: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; }
      .memoria-chat-message { margin-bottom: 8px; padding: 8px 12px; border-radius: 12px; max-width: 85%; width: fit-content; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      .user-message { background-color: var(--interactive-accent); color: var(--text-on-accent); align-self: flex-end; }
      .model-message { background-color: var(--background-secondary); align-self: flex-start; }
      .model-message.loading { color: var(--text-muted); }
      .memoria-chat-input-form { display: flex; padding: 10px; border-top: 1px solid var(--background-modifier-border); background-color: var(--background-primary); flex-shrink: 0; }
      .memoria-chat-input-textarea { flex-grow: 1; margin-right: 8px; resize: none; font-family: inherit; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); padding: 8px; min-height: 40px; }
      .memoria-chat-send-button { align-self: flex-end; min-height: 40px; }
    `;

    const messagesWrapperEl = container.createEl('div', { cls: 'memoria-chat-messages-wrapper' });
    this.chatMessagesEl = messagesWrapperEl.createEl('div', { cls: 'memoria-chat-messages-inner' });
    this.appendModelMessage('チャットウィンドウへようこそ！');

    const inputFormEl = container.createEl('form', { cls: 'memoria-chat-input-form' });
    inputFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      console.log('[MemoriaChat] Form submitted by button or direct form submit.');
      this.sendMessage();
    });

    this.inputEl = inputFormEl.createEl('textarea', {
      attr: {
        placeholder: 'メッセージを入力 (Shift+Enterで送信)', // プレースホルダーを変更
        rows: 2,
      },
      cls: 'memoria-chat-input-textarea'
    });

    // Keydown listener
    this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      console.log(`[MemoriaChat] Keydown: key="${event.key}", code="${event.code}", ctrlKey=${event.ctrlKey}, shiftKey=${event.shiftKey}, metaKey=${event.metaKey}, altKey=${event.altKey}`);

      const ctrlOrCmdPressed = Platform.isMacOS ? event.metaKey : event.ctrlKey;

      if (event.key === 'Enter') {
        console.log(`[MemoriaChat] Enter key pressed (keydown event). ctrlOrCmdPressed=${ctrlOrCmdPressed}, shiftKey=${event.shiftKey}`);

        // 1. Shift + Enter (Ctrl/Cmdキーの状態は問わない) -> 送信処理
        if (event.shiftKey) {
          console.log('[MemoriaChat] Condition Met: Shift + Enter. Attempting to send message.');
          event.preventDefault(); // デフォルトのEnterキーの動作（改行）をキャンセル
          this.sendMessage();
        }
        // 2. Enterキーのみ、または Ctrl/Cmd + Enter -> 改行 (デフォルト動作に任せる)
        // (上記以外のEnterキー関連の組み合わせ)
        else {
          console.log('[MemoriaChat] Condition Met: Enter (possibly with Ctrl/Cmd, but no Shift). Allowing default newline behavior.');
          // event.preventDefault() は呼び出さないので、テキストエリアは通常通り改行する
        }
      }
    });

    // Keyup listener (デバッグ用)
    this.inputEl.addEventListener('keyup', (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta" || event.key === "Shift") {
        console.log(`[MemoriaChat] Keyup: Modifier key released - key="${event.key}", code="${event.code}"`);
      }
    });


    const sendButtonEl = inputFormEl.createEl('button', {
      text: '送信',
      type: 'submit',
      cls: 'mod-cta memoria-chat-send-button'
    });
  }

  async onClose() {
    // クリーンアップ処理
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
    console.log('[MemoriaChat] sendMessage function called.');
    const message = this.inputEl.value;
    console.log(`[MemoriaChat] Message content before trim: "${message}"`);

    const trimmedMessage = message.trim();
    console.log(`[MemoriaChat] Message content after trim: "${trimmedMessage}"`);

    if (!trimmedMessage) {
        if (message.length > 0) {
            new Notice("メッセージが空白です。送信は行いません。");
            console.log('[MemoriaChat] Message is whitespace only. Aborting send.');
        } else {
            console.log('[MemoriaChat] Message is empty. Aborting send.');
        }
        return;
    }

    this.appendUserMessage(trimmedMessage);
    this.inputEl.value = '';
    this.inputEl.focus();

    if (!this.settings.geminiApiKey || !this.settings.geminiModel) {
      new Notice('Gemini APIキーまたはモデルが設定されていません。プラグイン設定を確認してください。');
      this.appendModelMessage('エラー: APIキーまたはモデルが未設定です。');
      console.log('[MemoriaChat] API key or model not set. Aborting API call.');
      return;
    }

    console.log('[MemoriaChat] Preparing to call API (dummy call).');
    const loadingMessageEl = this.appendMessage('応答を待っています...', 'loading');

    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const dummyResponse = `サーバーからの応答:\n「${trimmedMessage}」\nについてですね。\n\nこれはダミーの応答です。\n複数行の\nメッセージも\nこのように表示されます。`;
      loadingMessageEl.remove();
      this.appendModelMessage(dummyResponse);
      console.log('[MemoriaChat] Dummy response displayed.');
    } catch (error) {
      console.error('[MemoriaChat] Dummy API call error:', error);
      new Notice('ダミーAPIとの通信中にエラーが発生しました。');
      loadingMessageEl.remove();
      this.appendModelMessage('エラー: 応答を取得できませんでした。');
    } finally {
      this.scrollToBottom();
    }
  }
}
