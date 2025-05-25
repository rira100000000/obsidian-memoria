// main.ts
import { App, Editor, MarkdownView, Modal, Notice, Plugin, WorkspaceLeaf, PluginSettingTab, Setting } from 'obsidian';
import { GeminiPluginSettings, DEFAULT_SETTINGS, MemoriaSettingTab } from './src/settings';
import { CHAT_VIEW_TYPE, ChatView } from './src/ui/chatWindow';
import { LocationFetcher } from './src/locationFetcher';
import { ToolManager } from './src/tools/toolManager'; // ToolManagerをインポート

export default class ObsidianMemoria extends Plugin {
  settings: GeminiPluginSettings;
  locationFetcher: LocationFetcher;
  toolManager: ToolManager; // ToolManagerのインスタンスを保持

  async onload() {
    console.log('Loading Obsidian Memoria Plugin');

    await this.loadSettings();

    // LocationFetcherを初期化
    this.locationFetcher = new LocationFetcher(this);
    // ToolManagerを初期化
    this.toolManager = new ToolManager(this);

    // チャットビューを登録
    // ChatViewのコンストラクタにプラグインインスタンス (this) を渡す
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

    // 設定タブ
    this.addSettingTab(new MemoriaSettingTab(this.app, this));


    // APIキー未設定の通知
    if (!this.settings.geminiApiKey) {
      new Notice('Gemini APIキーが設定されていません。Obsidian Memoria プラグイン設定画面から設定してください。', 0);
    }

    console.log('Obsidian Memoria Plugin loaded successfully.');
  }

  onunload() {
    console.log('Unloading Obsidian Memoria Plugin');
    // ビューのデタッチなど、クリーンアップ処理があればここに追加
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // 設定変更を関連モジュールに通知
    if (this.locationFetcher && typeof this.locationFetcher.onSettingsChanged === 'function') {
      this.locationFetcher.onSettingsChanged(this.settings);
    }
    if (this.toolManager && typeof this.toolManager.onSettingsChanged === 'function') {
      this.toolManager.onSettingsChanged(); // ToolManagerにも設定変更を通知
    }

    // アクティブなChatViewがあれば、そちらにも設定変更を通知
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    leaves.forEach(leaf => {
      if (leaf.view instanceof ChatView) {
        leaf.view.onSettingsChanged();
      }
    });
  }

  async activateView(viewType: string) {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(viewType);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      // 既存のリーフがない場合は、新しいリーフを右側に作成
      leaf = workspace.getRightLeaf(false); // falseで既存の右リーフがなければnullを返す
      if (!leaf) { // 右リーフがない、またはメインのワークスペースしかない場合
        leaf = workspace.getLeaf(true); // 新しいリーフを分割して作成
      }
      if (leaf) {
        await leaf.setViewState({
          type: viewType,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf); // ビューを表示状態にする
    } else {
        console.error(`Failed to activate or create leaf for view type: ${viewType}`);
        new Notice(`チャットウィンドウを開けませんでした。`);
    }
  }
}
