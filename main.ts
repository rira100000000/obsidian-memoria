// main.ts
import { App, Editor, MarkdownView, Modal, Notice, Plugin, WorkspaceLeaf } from 'obsidian'; // WorkspaceLeaf を追加
import { GeminiPluginSettings, DEFAULT_SETTINGS, MemoriaSettingTab } from './src/settings';
import { CHAT_VIEW_TYPE, ChatView } from './src/ui/chatWindow'; // ChatView と VIEW_TYPE をインポート

// プラグインID: ObsidianMemoria (manifest.json の id と一致させる)

export default class ObsidianMemoria extends Plugin {
  settings: GeminiPluginSettings;

  async onload() {
    console.log('Loading Obsidian Memoria Plugin');

    await this.loadSettings();

    // チャットビューを登録
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => new ChatView(leaf, this) // this (プラグインインスタンス) を渡す
    );

    // リボンアイコンにチャットビューを開く機能を追加
    this.addRibbonIcon('messages-square', 'Memoria Chat', () => { // アイコンを変更
      this.activateView(CHAT_VIEW_TYPE);
    });

    // ステータスバーアイテム
    const statusBarItemEl = this.addStatusBarItem();
    statusBarItemEl.setText('Memoria Ready');

    // メインのチャットビューを開くコマンド
    this.addCommand({
      id: 'open-memoria-chat',
      name: 'Open Memoria Chat',
      callback: () => {
        this.activateView(CHAT_VIEW_TYPE);
      },
    });

    // --- サンプルコマンド群 (一旦コメントアウト) ---
    /*
    this.addCommand({
      id: 'open-sample-modal-simple',
      name: 'Open sample modal (simple) - Memoria',
      callback: () => {
        new MemoriaModal(this.app).open(); // リネーム後のモーダルクラスを使用
      }
    });
    this.addCommand({
      id: 'sample-editor-command',
      name: 'Sample editor command - Memoria',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        console.log(editor.getSelection());
        editor.replaceSelection('Sample Editor Command from Memoria');
      }
    });
    this.addCommand({
      id: 'open-sample-modal-complex',
      name: 'Open sample modal (complex) - Memoria',
      checkCallback: (checking: boolean) => {
        const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView) {
          if (!checking) {
            new MemoriaModal(this.app).open(); // リネーム後のモーダルクラスを使用
          }
          return true;
        }
        return false;
      }
    });
    */

    // 設定タブ
    this.addSettingTab(new MemoriaSettingTab(this.app, this));

    // DOMイベントとインターバル (デバッグ時以外はコメントアウト推奨)
    /*
    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      // console.log('click', evt);
    });
    this.registerInterval(window.setInterval(() => {
      // console.log('Obsidian Memoria interval check');
    }, 5 * 60 * 1000));
    */

    // APIキー未設定の通知
    if (!this.settings.geminiApiKey) {
      new Notice('Gemini APIキーが設定されていません。Obsidian Memoria プラグイン設定画面から設定してください。', 0);
    }

    // (オプション) プラグインロード時にチャットビューを自動で開く場合
    // this.app.workspace.onLayoutReady(async () => {
    //   this.activateView(CHAT_VIEW_TYPE);
    // });
  }

  onunload() {
    console.log('Unloading Obsidian Memoria Plugin');
    // ビュータイプを登録解除 (もし必要なら)
    // this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // チャットビューを開くメソッド
  async activateView(viewType: string) {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(viewType);

    if (leaves.length > 0) {
      // 既存のビューがあればそれをアクティブにする
      leaf = leaves[0];
    } else {
      // なければ新しいリーフを右側に作成して開く
      leaf = workspace.getRightLeaf(false); // false は既存のリーフを分割しない
      if (leaf) {
        await leaf.setViewState({
          type: viewType,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf); // ビューを表示する
    } else {
        console.error(`Failed to activate or create leaf for view type: ${viewType}`);
        new Notice(`チャットウィンドウを開けませんでした。`);
    }
  }
}

class MemoriaModal extends Modal { // クラス名を変更
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    // モーダルの内容をプラグインに合わせて変更 (例)
    contentEl.createEl('h3', { text: 'Memoria Modal' });
    contentEl.createEl('p', { text: 'これは Obsidian Memoria プラグインのモーダルです。' });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
