// src/settings.ts
import { App, PluginSettingTab, Setting, TextAreaComponent, TextComponent, SliderComponent, Notice } from 'obsidian';
import ObsidianMemoria from '../main';
import { ApiInfoModal } from './ui/apiInfoModal'; // ApiInfoModalをインポート

export interface GeminiPluginSettings {
  geminiModel: string;
  geminiApiKey: string;
  systemPrompt: string;
  keywordExtractionModel: string;
  maxContextLength: number;
  maxContextLengthForEvaluation: number;
  maxTagsToRetrieve: number;
  showLocationInChat: boolean; // チャットUIに位置情報をNoticeで表示するかの設定
  showWeatherInChat: boolean;  // チャットUIに天気情報をNoticeで表示するかの設定
  prompts?: {
    keywordExtractionPrompt?: string;
    contextEvaluationPromptBase?: string;
  };
}

export const DEFAULT_SETTINGS: GeminiPluginSettings = {
  geminiModel: 'gemini-1.5-flash-latest',
  geminiApiKey: '',
  systemPrompt: "You are a helpful assistant integrated into Obsidian. When answering, consider the 'Memory Recall Information' provided below, which is excerpted from past conversations and related notes. Use this information to provide more contextually relevant and consistent responses. If the information seems inaccurate or irrelevant to the current conversation, you don't need to force its use. Aim for a continuous interaction by reflecting the user's past opinions, events, or preferences. If you explicitly refer to memory information, you can subtly suggest it, like 'Regarding the matter of X we discussed earlier...'.",
  keywordExtractionModel: 'gemini-1.5-flash-latest',
  maxContextLength: 3500,
  maxContextLengthForEvaluation: 3500,
  maxTagsToRetrieve: 5,
  showLocationInChat: false, // デフォルトは非表示
  showWeatherInChat: false,  // デフォルトは非表示
  prompts: {
    keywordExtractionPrompt: `ユーザーの現在のメッセージは「{userPrompt}」です。このメッセージはLLMキャラクター「{llmRoleName}」に向けられています。\n\nこのメッセージの意図を理解する上で中心となる重要なキーワードやエンティティ（例: 人物名、プロジェクト名、特定の話題）を最大5つまで抽出してください。\nそして、抽出した各キーワードに対して、今回のメッセージ内での相対的な重要度を0から100の範囲でスコアリングしてください。\n\n応答は以下のJSON形式の配列で、キーワード(keyword)とそのスコア(score)を含めてください。\n例:\n[\n  { "keyword": "プロジェクトA", "score": 90 },\n  { "keyword": "締め切り", "score": 75 },\n  { "keyword": "山田さん", "score": 80 }\n]\n\nもし適切なキーワードが見つからない場合は、空の配列 [] を返してください。\nJSONオブジェクトのみを返し、他のテキストは含めないでください。`,
    contextEvaluationPromptBase: `あなたはユーザー「{llmRoleName}」の記憶と思考を補助するAIです。\nユーザーの現在の質問は「{userPrompt}」です。\n現在までに以下の参考情報が集まっています。\n---\n{currentContextForEval}\n---\nあなたのタスクは、これらの情報がユーザーの現在の質問に適切に応答するために十分かどうかを評価することです。\n応答は必ず以下のJSON形式で出力してください。\n\`\`\`json\n{\n  "sufficient_for_response": <true または false>,\n  "reasoning": "<判断理由を簡潔に記述>",\n  "next_summary_notes_to_fetch": ["<もし 'sufficient_for_response' が false で、次に参照すべきサマリーノートがあれば、そのファイル名を複数指定 (例: 'SN-YYYYMMDDHHMM-Topic1', 'SN-YYYYMMDDHHMM-Topic2')。不要なら空配列 []>"],\n  "requires_full_log_for_summary_note": "<もし 'sufficient_for_response' が false で、特定のサマリーノートのフルログが必要な場合、そのサマリーノートのファイル名を指定 (例: 'SN-YYYYMMDDHHMM-TopicX')。不要なら null>"\n}\n\`\`\`\n考慮事項:\n- 現在の評価レベルは「{currentLevel}」です。\n- {currentLevelSpecificConsideration}\n- ユーザーの質問の意図を深く理解し、本当に必要な情報だけを要求するようにしてください。\n- \`next_summary_notes_to_fetch\` と \`requires_full_log_for_summary_note\` は、\`sufficient_for_response\` が false の場合にのみ意味を持ちます。\n- \`requires_full_log_for_summary_note\` は、既にSNを読み込んだ後、そのSNに紐づくFLが必要な場合に指定します。\nJSONオブジェクトのみを返し、他のテキストは含めないでください。`,
  }
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
      .setName('Gemini Model (Main Chat & Context Evaluation)')
      .setDesc('Enter the name of the Gemini model for chat responses and context evaluation.')
      .addText(text => text
        .setPlaceholder('例: gemini-1.5-pro-latest, gemini-1.5-flash-latest')
        .setValue(this.plugin.settings.geminiModel)
        .onChange(async (value) => {
          this.plugin.settings.geminiModel = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc('Enter your Gemini API key.')
      .addText(text => text
        .setPlaceholder('Enter your Gemini API key...')
        .setValue(this.plugin.settings.geminiApiKey)
        .onChange(async (value) => {
          this.plugin.settings.geminiApiKey = value;
          await this.plugin.saveSettings();
        })
        .inputEl.setAttribute('type', 'password'));

    new Setting(containerEl)
      .setName('System Prompt (Base)')
      .setDesc('Set the base system prompt for the AI. Memory recall instructions will be appended to this.')
      .addTextArea((text: TextAreaComponent) => {
        text
          .setPlaceholder('Example: You are a helpful assistant.')
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
        text.inputEl.style.width = '100%';
        text.inputEl.style.minHeight = '100px';
      });

    containerEl.createEl('h3', { text: 'Memory Recall Settings' });

    new Setting(containerEl)
      .setName('Keyword Extraction Model')
      .setDesc('Model used for extracting keywords from user prompts. Can be the same as main or a lighter one.')
      .addText(text => text
        .setPlaceholder('例: gemini-1.5-flash-latest')
        .setValue(this.plugin.settings.keywordExtractionModel)
        .onChange(async (value) => {
          this.plugin.settings.keywordExtractionModel = value;
          await this.plugin.saveSettings();
        }));
    
    let maxTagsSlider: SliderComponent;
    const maxTagsSetting = new Setting(containerEl)
        .setName('Max Tags to Retrieve')
        .setDesc(`Maximum number of Tag Profiling Notes (TPNs) to retrieve initially based on keyword relevance. Current: ${this.plugin.settings.maxTagsToRetrieve}`)
        .addSlider(slider => {
            maxTagsSlider = slider;
            slider
                .setLimits(1, 20, 1)
                .setValue(this.plugin.settings.maxTagsToRetrieve)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxTagsToRetrieve = value;
                    maxTagsSetting.setDesc(`Maximum number of Tag Profiling Notes (TPNs) to retrieve initially based on keyword relevance. Current: ${value}`);
                    await this.plugin.saveSettings();
                });
        });


    let maxContextLengthSlider: SliderComponent;
    const maxContextLengthSetting = new Setting(containerEl)
        .setName('Max Context Length for Final LLM')
        .setDesc(`Maximum character length of the combined retrieved context passed to the main LLM. Current: ${this.plugin.settings.maxContextLength}`)
        .addSlider(slider => {
            maxContextLengthSlider = slider;
            slider
                .setLimits(1000, 10000, 100)
                .setValue(this.plugin.settings.maxContextLength)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxContextLength = value;
                    maxContextLengthSetting.setDesc(`Maximum character length of the combined retrieved context passed to the main LLM. Current: ${value}`);
                    await this.plugin.saveSettings();
                });
        });

    let maxContextLengthForEvalSlider: SliderComponent;
    const maxContextLengthForEvalSetting = new Setting(containerEl)
        .setName('Max Context Length for LLM Evaluation')
        .setDesc(`Maximum character length of the context passed to the LLM for evaluation steps. Current: ${this.plugin.settings.maxContextLengthForEvaluation}`)
        .addSlider(slider => {
            maxContextLengthForEvalSlider = slider;
            slider
                .setLimits(1000, 10000, 100)
                .setValue(this.plugin.settings.maxContextLengthForEvaluation)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxContextLengthForEvaluation = value;
                    maxContextLengthForEvalSetting.setDesc(`Maximum character length of the context passed to the LLM for evaluation steps. Current: ${value}`);
                    await this.plugin.saveSettings();
                });
        });

    containerEl.createEl('h3', { text: 'Contextual Information Settings (Location & Weather)' });
    new Setting(containerEl)
        .setName('Show location in chat (Notice)')
        .setDesc('If enabled, a notice with the fetched location (city, country) will be shown in the chat UI upon first message.')
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.showLocationInChat)
            .onChange(async (value) => {
                this.plugin.settings.showLocationInChat = value;
                await this.plugin.saveSettings();
            }));
    new Setting(containerEl)
        .setName('Show weather in chat (Notice)')
        .setDesc('If enabled, a notice with the fetched weather (description, temperature) will be shown in the chat UI upon first message.')
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.showWeatherInChat)
            .onChange(async (value) => {
                this.plugin.settings.showWeatherInChat = value;
                await this.plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName('External API Information')
        .setDesc('View information about the external APIs used for location and weather.')
        .addButton(button => button
            .setButtonText('Show API Information')
            .onClick(() => {
                if (this.plugin.locationFetcher) {
                    new ApiInfoModal(this.app, this.plugin.locationFetcher).open();
                } else {
                    new Notice('LocationFetcher is not available. Cannot show API info.');
                    console.error('[MemoriaSettingTab] LocationFetcher instance is not available on plugin object.');
                }
            }));


    containerEl.createEl('h3', { text: 'Advanced Prompt Settings (JSON format expected if modified)' });
    
    new Setting(containerEl)
        .setName('Keyword Extraction Prompt Template')
        .setDesc('Template for prompting keyword extraction. Use {userPrompt} and {llmRoleName}.')
        .addTextArea(text => {
            text
                .setValue(this.plugin.settings.prompts?.keywordExtractionPrompt || DEFAULT_SETTINGS.prompts?.keywordExtractionPrompt || "")
                .onChange(async (value) => {
                    if (!this.plugin.settings.prompts) this.plugin.settings.prompts = {};
                    this.plugin.settings.prompts.keywordExtractionPrompt = value;
                    await this.plugin.saveSettings();
                });
            text.inputEl.rows = 8;
            text.inputEl.style.width = '100%';
            text.inputEl.style.fontFamily = 'monospace';
        });

    new Setting(containerEl)
        .setName('Context Evaluation Prompt Base Template')
        .setDesc('Base template for prompting context evaluation. Use {llmRoleName}, {userPrompt}, {currentContextForEval}, {currentLevel}, {currentLevelSpecificConsideration}.')
        .addTextArea(text => {
            text
                .setValue(this.plugin.settings.prompts?.contextEvaluationPromptBase || DEFAULT_SETTINGS.prompts?.contextEvaluationPromptBase || "")
                .onChange(async (value) => {
                    if (!this.plugin.settings.prompts) this.plugin.settings.prompts = {};
                    this.plugin.settings.prompts.contextEvaluationPromptBase = value;
                    await this.plugin.saveSettings();
                });
            text.inputEl.rows = 12;
            text.inputEl.style.width = '100%';
            text.inputEl.style.fontFamily = 'monospace';
        });
  }
}
