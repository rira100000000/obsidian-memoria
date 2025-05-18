// settings.ts
import { App, PluginSettingTab, Setting } from 'obsidian';
import ObsidianMemoria from '../main';

export interface GeminiPluginSettings {
  geminiModel: string;
  geminiApiKey: string;
}

export const DEFAULT_SETTINGS: GeminiPluginSettings = {
  geminiModel: 'gemini-2.0-flash',
  geminiApiKey: '',
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
        .setPlaceholder('例: gemini-1.5-pro-latest')
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
  }
}
