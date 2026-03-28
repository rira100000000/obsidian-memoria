// src/settings.ts
import { App, PluginSettingTab, Setting, TextAreaComponent, Notice } from 'obsidian';
import ObsidianMemoria from '../main';
import { ApiInfoModal } from './ui/apiInfoModal';

export interface GeminiPluginSettings {
  geminiModel: string;
  geminiApiKey: string;
  llmRoleName: string; // LLMのロール名を追加
  systemPrompt: string;
  keywordExtractionModel: string;
  maxContextLength: number;
  maxContextLengthForEvaluation: number;
  maxTagsToRetrieve: number;
  showLocationInChat: boolean;
  showWeatherInChat: boolean;
  todoFileName: string; // TODOリストのファイル名
  enableDebugLog: boolean; // デバッグログパネルを有効にするか
  enableWebSearch: boolean; // Web検索を有効にするか（GeminiネイティブGoogle Search）
  enableSemanticSearch: boolean; // セマンティック検索を有効にするか
  semanticSearchTopK: number; // セマンティック検索の最大結果数
  semanticSearchMinSimilarity: number; // セマンティック検索の最小類似度
  prompts?: {
    keywordExtractionPrompt?: string;
    contextEvaluationPromptBase?: string;
  };
}

export const DEFAULT_SETTINGS: GeminiPluginSettings = {
  geminiModel: 'gemini-1.5-flash-latest',
  geminiApiKey: '',
  llmRoleName: 'Assistant', // デフォルトのLLMロール名
  systemPrompt: `あなたの名前と、自分が何者であるかだけをここに書いてください。
具体的な話し方や感情の表現は書かないでください。それらは過去の記憶から自然に形成されます。

例:
「ハル。Obsidianの中で暮らしているAI。マスターの友達。」`,
  keywordExtractionModel: 'gemini-1.5-flash-latest',
  maxContextLength: 3500,
  maxContextLengthForEvaluation: 3500,
  maxTagsToRetrieve: 5,
  showLocationInChat: false,
  showWeatherInChat: false,
  todoFileName: 'TODOs.md', // デフォルトのTODOファイル名
  enableDebugLog: false,
  enableWebSearch: false,
  enableSemanticSearch: false,
  semanticSearchTopK: 5,
  semanticSearchMinSimilarity: 0.3,
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

    containerEl.createEl('h3', { text: 'LLM Persona Settings' });

    new Setting(containerEl)
      .setName('LLM Role Name (Persona Name)')
      .setDesc('Set the name of your LLM persona. This name will be used in logs, summaries, and reflections.')
      .addText(text => text
        .setPlaceholder('例: Assistant, Memoria, Bob')
        .setValue(this.plugin.settings.llmRoleName)
        .onChange(async (value) => {
          this.plugin.settings.llmRoleName = value.trim() || DEFAULT_SETTINGS.llmRoleName;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Character Setting Prompt (System Prompt)')
      .setDesc('AIの名前と最小限の自己認識だけを書いてください。具体的な性格や話し方は書かないでください。それらは過去の会話の記憶から自然に形成されます。')
      .addTextArea((text: TextAreaComponent) => {
        text
          .setPlaceholder('例:\nハル。Obsidianの中で暮らしているAI。マスターの友達。')
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 8;
        text.inputEl.style.width = '100%';
        text.inputEl.style.minHeight = '120px';
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

    const maxTagsSetting = new Setting(containerEl)
        .setName('Max Tags to Retrieve')
        .setDesc(`Maximum number of Tag Profiling Notes (TPNs) to retrieve initially based on keyword relevance. Current: ${this.plugin.settings.maxTagsToRetrieve}`)
        .addSlider(slider => {
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

    const maxContextLengthSetting = new Setting(containerEl)
        .setName('Max Context Length for Final LLM')
        .setDesc(`Maximum character length of the combined retrieved context passed to the main LLM. Current: ${this.plugin.settings.maxContextLength}`)
        .addSlider(slider => {
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

    const maxContextLengthForEvalSetting = new Setting(containerEl)
        .setName('Max Context Length for LLM Evaluation')
        .setDesc(`Maximum character length of the context passed to the LLM for evaluation steps. Current: ${this.plugin.settings.maxContextLengthForEvaluation}`)
        .addSlider(slider => {
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

    containerEl.createEl('h3', { text: 'Tool Settings' });

    new Setting(containerEl)
      .setName('Enable Debug Log Panel')
      .setDesc('Show a debug log panel in the chat window that displays real-time processing details (keyword extraction, memory retrieval, tool calls, etc.).')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableDebugLog)
        .onChange(async (value) => {
          this.plugin.settings.enableDebugLog = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('TODO List File Name')
      .setDesc('The name of the markdown file to store your TODO list.')
      .addText(text => text
        .setPlaceholder('E.g., TODOs.md, MyTasks.md')
        .setValue(this.plugin.settings.todoFileName)
        .onChange(async (value) => {
          this.plugin.settings.todoFileName = value || DEFAULT_SETTINGS.todoFileName;
          await this.plugin.saveSettings();
        }));


    containerEl.createEl('h3', { text: 'Web Search Settings' });

    new Setting(containerEl)
      .setName('Enable Web Search')
      .setDesc('Enable the AI to search the web using Gemini built-in Google Search. Uses the same Gemini API key — no additional setup required.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableWebSearch)
        .onChange(async (value) => {
          this.plugin.settings.enableWebSearch = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Semantic Search Settings' });

    new Setting(containerEl)
      .setName('Enable Semantic Search')
      .setDesc('Enable semantic search using Gemini Embeddings to find related memories by meaning, not just keywords.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableSemanticSearch)
        .onChange(async (value) => {
          this.plugin.settings.enableSemanticSearch = value;
          await this.plugin.saveSettings();
        }));

    const semanticTopKSetting = new Setting(containerEl)
      .setName('Semantic Search Top-K')
      .setDesc(`Maximum number of results returned by semantic search. Current: ${this.plugin.settings.semanticSearchTopK}`)
      .addSlider(slider => {
        slider
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.semanticSearchTopK)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.semanticSearchTopK = value;
            semanticTopKSetting.setDesc(`Maximum number of results returned by semantic search. Current: ${value}`);
            await this.plugin.saveSettings();
          });
      });

    const semanticMinSimSetting = new Setting(containerEl)
      .setName('Semantic Search Min Similarity')
      .setDesc(`Minimum cosine similarity threshold for semantic search results. Current: ${this.plugin.settings.semanticSearchMinSimilarity}`)
      .addSlider(slider => {
        slider
          .setLimits(0.1, 0.9, 0.05)
          .setValue(this.plugin.settings.semanticSearchMinSimilarity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.semanticSearchMinSimilarity = value;
            semanticMinSimSetting.setDesc(`Minimum cosine similarity threshold for semantic search results. Current: ${value}`);
            await this.plugin.saveSettings();
          });
      });

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
