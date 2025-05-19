// src/settings.ts
import { App, PluginSettingTab, Setting, TextAreaComponent } from 'obsidian'; // TextAreaComponent をインポート
import ObsidianMemoria from '../main';

export interface GeminiPluginSettings {
  geminiModel: string;
  geminiApiKey: string;
  systemPrompt: string; // システムプロンプト用の設定項目を追加
}

export const DEFAULT_SETTINGS: GeminiPluginSettings = {
  geminiModel: 'gemini-2.0-flash', // モデル名を修正 (例: gemini-1.5-flash)
  geminiApiKey: '',
  systemPrompt: '', // デフォルト値を設定
};

export class MemoriaSettingTab extends PluginSettingTab {
  plugin: ObsidianMemoria;

  constructor(app: App, plugin: ObsidianMemoria) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Memoria - Gemini API Settings' });

    new Setting(containerEl)
      .setName('Gemini Model')
      .setDesc('Enter the name of the Gemini model you are using')
      .addText(text => text
        .setPlaceholder('例: gemini-1.5-pro-latest, gemini-1.5-flash') // プレースホルダーにflashモデルの例も追加
        .setValue(this.plugin.settings.geminiModel)
        .onChange(async (value) => {
          this.plugin.settings.geminiModel = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc('Enter your Gemini API key')
      .addText(text => text
        .setPlaceholder('Enter your Gemini API key...')
        .setValue(this.plugin.settings.geminiApiKey)
        .onChange(async (value) => {
          this.plugin.settings.geminiApiKey = value;
          await this.plugin.saveSettings();
        })
        .inputEl.setAttribute('type', 'password'));

    // システムプロンプト設定エリア
    new Setting(containerEl)
      .setName('System Prompt')
      .setDesc('Set a system prompt that will be prepended to your messages to the AI. This can be used to define the AI\'s persona or provide context.') // 説明を英語に変更
      .addTextArea((text: TextAreaComponent) => { // テキストエリアを使用
        text
          .setPlaceholder('Example: You are a helpful assistant.') // プレースホルダーを英語に変更
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5; // テキストエリアの行数を指定
        text.inputEl.style.width = '100%'; // 幅を100%に設定
        text.inputEl.style.minHeight = '100px'; // 最小の高さを設定
      });
  }
}
