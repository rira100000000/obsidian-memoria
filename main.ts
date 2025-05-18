import { App, Editor, MarkdownView, Modal, Notice, Plugin } from 'obsidian';
import { GeminiPluginSettings, DEFAULT_SETTINGS, MemoriaSettingTab } from './src/settings';

// プラグインID: ObsidianMemoria (manifest.json の id と一致させる)

export default class ObsidianMemoria extends Plugin {
  settings: GeminiPluginSettings;

  async onload() {
    console.log('Loading Obsidian Memoria Plugin'); // プラグイン名を変更

    await this.loadSettings();

    // This creates an icon in the left ribbon.
    const ribbonIconEl = this.addRibbonIcon('brain', 'Obsidian Memoria', (evt: MouseEvent) => { // アイコンとツールチップを変更
      // Called when the user clicks the icon.
      new Notice('Obsidian Memoria is active!'); // 通知メッセージを変更
    });
    // Perform additional things with the ribbon
    ribbonIconEl.addClass('obsidian-memoria-ribbon-class'); // クラス名を変更

    // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
    const statusBarItemEl = this.addStatusBarItem();
    statusBarItemEl.setText('Memoria Ready'); // ステータスバーテキストを変更

    // This adds a simple command that can be triggered anywhere
		// this.addCommand({
    //   id: 'open-sample-modal-simple', // コマンドIDはサンプルとして残すか、独自のものに変更
    //   name: 'Open sample modal (simple) - Memoria', // コマンド名を変更
    //   callback: () => {
    //     new SampleModal(this.app).open();
    //   }
    // });
    // // This adds an editor command that can perform some operation on the current editor instance
    // this.addCommand({
    //   id: 'sample-editor-command', // コマンドIDはサンプルとして残すか、独自のものに変更
    //   name: 'Sample editor command - Memoria', // コマンド名を変更
    //   editorCallback: (editor: Editor, view: MarkdownView) => {
    //     console.log(editor.getSelection());
    //     editor.replaceSelection('Sample Editor Command from Memoria');
    //   }
    // });

		// This adds a complex command that can check whether the current state of the app allows execution of the command
			this.addCommand({
				id: 'open-sample-modal-complex', // コマンドIDはサンプルとして残すか、独自のものに変更
				name: 'Open sample modal (complex) - Memoria', // コマンド名を変更
				checkCallback: (checking: boolean) => {
					const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (markdownView) {
						if (!checking) {
							new MemoriaModal(this.app).open();
						}
						return true;
					}
					return false; // checkCallback では boolean を返すように修正
				}
			});

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new MemoriaSettingTab(this.app, this)); // 新しい設定タブクラスを使用

    // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      // console.log('click', evt); // デバッグ時以外はコメントアウト推奨
    });

    // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
    this.registerInterval(window.setInterval(() => {
      // console.log('Obsidian Memoria interval check'); // デバッグ時以外はコメントアウト推奨
    }, 5 * 60 * 1000));

    // (オプション) APIキーが設定されていない場合に通知を表示
    if (!this.settings.geminiApiKey) {
      new Notice('Gemini APIキーが設定されていません。Obsidian Memoria プラグイン設定画面から設定してください。', 0); // 0は通知が自動で消えないようにする設定
    }
  }

  onunload() {
    console.log('Unloading Obsidian Memoria Plugin');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class MemoriaModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.setText('Woah! This is a sample modal from Obsidian Memoria.');
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
