// main.ts
import { App, Editor, MarkdownView, Modal, Notice, Plugin, WorkspaceLeaf, PluginSettingTab, Setting } from 'obsidian'; // PluginSettingTab と Setting もインポート
import { GeminiPluginSettings, DEFAULT_SETTINGS, MemoriaSettingTab } from './src/settings';
import { CHAT_VIEW_TYPE, ChatView } from './src/ui/chatWindow';
// TagProfiler は ChatView 内部でインポートおよびインスタンス化されるため、ここでの直接インポートは不要です。
// SummaryGenerator も同様です。

export default class ObsidianMemoria extends Plugin {
  settings: GeminiPluginSettings;

  async onload() {
    console.log('Loading Obsidian Memoria Plugin');

    await this.loadSettings();

    // チャットビューを登録
    // ChatView のコンストラクタにプラグインインスタンス (this) を渡すことで、
    // ChatView は SummaryGenerator や TagProfiler を初期化し、
    // それらのモジュールはプラグインの設定情報 (this.settings) にアクセスできます。
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => new ChatView(leaf, this)
    );

    // リボンアイコンにチャットビューを開く機能を追加
    this.addRibbonIcon('messages-square', 'Memoria Chat', () => {
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

    // --- サンプルコマンド群 (コメントアウト) ---
    /*
    this.addCommand({
      id: 'open-sample-modal-simple',
      name: 'Open sample modal (simple) - Memoria',
      callback: () => {
        new MemoriaModal(this.app).open();
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
            new MemoriaModal(this.app).open();
          }
          return true;
        }
        return false;
      }
    });
    */

    // 設定タブ
    this.addSettingTab(new MemoriaSettingTab(this.app, this));

    // DOMイベントとインターバル (コメントアウト)
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
      new Notice('Gemini APIキーが設定されていません。Obsidian Memoria プラグイン設定画面から設定してください。', 0); // 0で通知が消えないようにする
    }

    // (オプション) プラグインロード時にチャットビューを自動で開く場合
    // this.app.workspace.onLayoutReady(async () => {
    //   this.activateView(CHAT_VIEW_TYPE);
    // });

    console.log('Obsidian Memoria Plugin loaded successfully.');
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
    // 設定変更をChatViewに通知し、ChatView経由でSummaryGeneratorやTagProfilerのモデルも再初期化する
    // これはChatViewのonSettingsChangedメソッドで行われる
    const chatViewLeaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (chatViewLeaf && chatViewLeaf.view instanceof ChatView) {
        chatViewLeaf.view.onSettingsChanged();
    }
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
      leaf = workspace.getRightLeaf(false);
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

// サンプルモーダル (現在は使用されていないが、参考として残す)
class MemoriaModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Memoria Modal' });
    contentEl.createEl('p', { text: 'これは Obsidian Memoria プラグインのモーダルです。' });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
