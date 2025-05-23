// main.ts
import { App, Editor, MarkdownView, Modal, Notice, Plugin, WorkspaceLeaf, PluginSettingTab, Setting } from 'obsidian'; // PluginSettingTab と Setting もインポート
import { GeminiPluginSettings, DEFAULT_SETTINGS, MemoriaSettingTab } from './src/settings';
import { CHAT_VIEW_TYPE, ChatView } from './src/ui/chatWindow';
import { LocationFetcher } from './src/locationFetcher'; // LocationFetcherをインポート
// TagProfiler は ChatView 内部でインポートおよびインスタンス化されるため、ここでの直接インポートは不要です。
// SummaryGenerator も同様です。

export default class ObsidianMemoria extends Plugin {
  settings: GeminiPluginSettings;
  locationFetcher: LocationFetcher; // LocationFetcherのインスタンスを保持

  async onload() {
    console.log('Loading Obsidian Memoria Plugin');

    await this.loadSettings();

    // LocationFetcherを初期化
    this.locationFetcher = new LocationFetcher(this);

    // チャットビューを登録
    // ChatView のコンストラクタにプラグインインスタンス (this) を渡すことで、
    // ChatView は SummaryGenerator や TagProfiler を初期化し、
    // それらのモジュールはプラグインの設定情報 (this.settings) にアクセスできます。
    // また、LocationFetcherも渡せるようにする (ChatViewが直接使う場合)か、
    // プラグインインスタンス経由でアクセスできるようにする。
    // 今回はChatViewがLocationFetcherを直接持つように変更。
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => new ChatView(leaf, this) // ChatViewのコンストラクタでLocationFetcherを受け取るように変更が必要
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

    // 設定タブ (LocationFetcherを渡す必要はない。SettingTabがpluginインスタンスを持つため)
    this.addSettingTab(new MemoriaSettingTab(this.app, this));


    // APIキー未設定の通知
    if (!this.settings.geminiApiKey) {
      new Notice('Gemini APIキーが設定されていません。Obsidian Memoria プラグイン設定画面から設定してください。', 0); // 0で通知が消えないようにする
    }

    console.log('Obsidian Memoria Plugin loaded successfully.');
  }

  onunload() {
    console.log('Unloading Obsidian Memoria Plugin');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    const chatViewLeaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (chatViewLeaf && chatViewLeaf.view instanceof ChatView) {
        chatViewLeaf.view.onSettingsChanged();
    }
  }

  async activateView(viewType: string) {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(viewType);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: viewType,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    } else {
        console.error(`Failed to activate or create leaf for view type: ${viewType}`);
        new Notice(`チャットウィンドウを開けませんでした。`);
    }
  }
}
