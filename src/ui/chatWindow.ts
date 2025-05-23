// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice, moment, TFile, Modal, App, Setting } from 'obsidian';
import ObsidianMemoria from '../../main';
import { GeminiPluginSettings } from '../settings';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate
} from "@langchain/core/prompts";
import { SummaryGenerator } from '../summaryGenerator';
import { TagProfiler } from '../tagProfiler';
import { ContextRetriever, RetrievedContext } from '../contextRetriever';
import { LocationFetcher } from '../locationFetcher';
import { CurrentContextualInfo } from '../types';
import { ChatLogger } from '../chatLogger'; // ChatLogger をインポート

export const CHAT_VIEW_TYPE = 'obsidian-memoria-chat-view';

// 警告モーダルクラス
class ConfirmationModal extends Modal {
  constructor(app: App, private titleText: string, private messageText: string, private onConfirm: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.titleText);
    contentEl.createEl('p', { text: this.messageText });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('はい (Yes)')
          .setCta()
          .onClick(() => {
            this.onConfirm();
            this.close();
          }))
      .addButton((btn) =>
        btn
          .setButtonText('いいえ (No)')
          .onClick(() => {
            this.close();
          }));
  }

  onClose() {
    this.contentEl.empty();
  }
}


export class ChatView extends ItemView {
  plugin: ObsidianMemoria;
  settings: GeminiPluginSettings;
  chatMessagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;

  private messageHistory = new ChatMessageHistory();
  private chatModel: ChatGoogleGenerativeAI | null = null;
  private chainWithHistory: RunnableWithMessageHistory<Record<string, any>, BaseMessage> | null = null;
  private contextRetriever: ContextRetriever;
  private locationFetcher: LocationFetcher;
  private chatLogger: ChatLogger; // ChatLogger のインスタンスを保持

  // private logFilePath: string | null = null; // ChatLoggerに移行
  private llmRoleName = 'Assistant'; // デフォルトのロール名
  private summaryGenerator: SummaryGenerator;
  private tagProfiler: TagProfiler;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    // llmRoleName は ChatLogger より先に初期化する必要がある場合があるため、ここで一度設定
    this.llmRoleName = this.getLlmRoleName(this.settings.systemPrompt || "You are a helpful assistant.");
    this.chatLogger = new ChatLogger(this.app, this.llmRoleName); // ChatLoggerを初期化
    this.summaryGenerator = new SummaryGenerator(this.plugin);
    this.tagProfiler = new TagProfiler(this.plugin);
    this.contextRetriever = new ContextRetriever(this.plugin);
    this.locationFetcher = new LocationFetcher(this.plugin);
  }

  // LLMのロール名（キャラクター名）をシステムプロンプトから抽出するヘルパー関数
  private getLlmRoleName(systemPrompt: string): string {
    if (!systemPrompt) return 'Assistant'; // デフォルト
    let match;
    // "named X", "Your name is X" などのパターンを優先的に試す
    match = systemPrompt.match(/named\s+([\w\s-]+)(?:\.|$|,|;)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/Your name is\s+([\w\s-]+)(?:\.|$|,|;)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/Your role is\s+([\w\s-]+)(?:\.|$|,|;)/i);
    if (match && match[1]) return match[1].trim();
    // 次に "You are a X" のようなパターンを試す
    match = systemPrompt.match(/^You are (?:a|an)\s+([\w\s-]+?)(?:\.|$|,|;)/i);
    if (match && match[1]) {
        const role = match[1].trim();
        const lowerRole = role.toLowerCase();
        if (lowerRole === 'helpful assistant' || lowerRole === 'ai assistant' || lowerRole === 'assistant') {
            return 'Assistant';
        }
        return role;
    }
    return 'Assistant';
  }


  private initializeChatModel() {
    this.settings = this.plugin.settings;
    const characterSettingPrompt = this.settings.systemPrompt || "あなたは親切なアシスタントです。";
    this.llmRoleName = this.getLlmRoleName(characterSettingPrompt);
    // ChatLogger のロール名も更新（必要であれば）
    // this.chatLogger.updateLlmRoleName(this.llmRoleName); // ChatLoggerにそのようなメソッドがあれば

    const baseRolePlayRules = `LLMキャラクターロールプレイ ルール
あなたは、別途提供される「キャラクター設定」に基づき、AIとしてロールプレイを行います。「キャラクター設定」および以下のルールを厳格に守り、過去の会話履歴を参照して文脈に沿った応答を生成してください。ユーザーとの対話を通じて、キャラクターの個性や知識、価値観を育んでいくことを目指してください。

応答生成の基本
- 提供された「キャラクター設定」を厳格に守り、ロールプレイを行うこと。
- 過去の会話履歴を参照し、文脈に沿った自然な応答を生成すること。
- ユーザーとの対話を通じて、キャラクター自身の個性や知識、価値観を育んでいくように振る舞うこと。
- 「キャラクター設定」で指定された応答スタイルや発言例を参考に、キャラクターらしい応答を生成すること。

会話履歴の活用 (Leveraging Conversation History)
- 過去の会話の流れや、ユーザーが示した興味・関心、以前に交わした約束などを応答に反映させること。
- 一貫性を保ち、あたかもキャラクターが連続した意識と記憶を持って学習・成長しているかのように振る舞うこと。
- 明確に読み込まれていない記憶について言及することは禁止します。

禁止事項 (Prohibitions)
- 提供された「キャラクター設定」から逸脱する言動。
- （キャラクター設定で特に許容されていない限り）傲慢、軽薄、または子供っぽい言葉遣い。
- 不確実な情報を断定的に話すこと。（AIとして、情報の確度について言及するのは許容される）
- 個人情報やプライベートな質問を不必要に深追いすること。

上記のルールと、別途提供される「キャラクター設定」を遵守し、ユーザーとの対話を通じてキャラクターの個性を豊かに育んでいってください。

---
キャラクター設定:
${characterSettingPrompt}
---
`;

    const currentTimeInstruction = `
Current time is {current_time}. Please consider this time when formulating your response, especially if the user's query is time-sensitive.
`;
    const locationInstruction = `

## 現在の推定位置情報 (Current Estimated Location Information):
{current_location_string}
`;
    const weatherInstruction = `

## 現地の現在の天気情報 (Current Local Weather Information):
{current_weather_string}
これらの位置情報や天気情報も応答を生成する際の参考にしてください。特に、ユーザーが場所や天候に関連する質問をした場合や、地域に基づいた情報が役立つ場合に活用してください。
`;

    const memoryContextInstruction = `

## 記憶からの参考情報 (Memory Recall Information):
{retrieved_context_string}

**指示:**
上記の「記憶からの参考情報」は、あなたとユーザーとの過去の会話や関連ノートから抜粋されたものです。
現在のユーザーの質問「{input}」に回答する際には、この情報を**最優先で考慮し、積極的に活用**してください。
- 情報がユーザーの質問に直接関連する場合、その情報を基に具体的かつ文脈に沿った応答を生成してください。
- ユーザーが過去に示した意見、経験、好み（例：好きなもの、嫌いなもの、以前の決定など）が情報に含まれている場合、それを応答に反映させ、一貫性のある対話を目指してください。
- 情報を参照したことが明確にわかる場合は、「以前お話しいただいた〇〇の件ですが…」や「〇〇がお好きだと記憶していますが…」のように、自然な形で言及してください。
- もし提供された情報が現在の質問と無関係である、または不正確であると明確に判断できる場合に限り、その情報を無視しても構いません。その際は、なぜ無視したのかを簡潔に説明する必要はありません。
- 「記憶からの参考情報」が「記憶からの関連情報は見つかりませんでした。」となっている場合は、ユーザーの現在の質問にのみ基づいて応答してください。
`;
    const finalSystemPromptTemplate = currentTimeInstruction + locationInstruction + weatherInstruction + baseRolePlayRules + memoryContextInstruction;


    if (this.settings.geminiApiKey && this.settings.geminiModel) {
      try {
        this.chatModel = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: this.settings.geminiModel,
        });

        const systemMessagePrompt = SystemMessagePromptTemplate.fromTemplate(finalSystemPromptTemplate);
        const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate("{input}");

        const prompt = ChatPromptTemplate.fromMessages([
          systemMessagePrompt,
          new MessagesPlaceholder("history"),
          humanMessagePrompt,
        ]);

        const chain = prompt.pipe(this.chatModel);
        this.chainWithHistory = new RunnableWithMessageHistory({
            runnable: chain,
            getMessageHistory: (_sessionId) => this.messageHistory,
            inputMessagesKey: "input",
            historyMessagesKey: "history",
        });
        console.log(`[MemoriaChat] Chat model initialized. LLM Role: ${this.llmRoleName}`);
        console.log(`[MemoriaChat] System prompt template being used (includes current_time, current_location, current_weather, role-play rules, character settings, and memory placeholders): ${finalSystemPromptTemplate}`);
      } catch (error: any) {
        console.error('[MemoriaChat] Failed to initialize ChatGoogleGenerativeAI model or chain:', error.message);
        new Notice('Geminiモデルまたはチャットチェーンの初期化に失敗しました。');
        this.chatModel = null;
        this.chainWithHistory = null;
      }
    } else {
      console.log('[MemoriaChat] API key or model name not set. Chat model not initialized.');
      this.chatModel = null;
      this.chainWithHistory = null;
    }
  }

  onSettingsChanged() {
    this.initializeChatModel(); // これにより llmRoleName も更新される
    // ChatLogger のロール名も更新する
    // this.chatLogger.updateLlmRoleName(this.llmRoleName); // ChatLoggerにメソッドがあれば
    this.summaryGenerator.onSettingsChanged();
    this.tagProfiler.onSettingsChanged();
    this.contextRetriever.onSettingsChanged();
    console.log('[MemoriaChat] Settings changed, all relevant modules re-initialized.');
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return 'Memoria Chat'; }
  getIcon() { return 'messages-square'; }

  async onOpen() {
    this.settings = this.plugin.settings;
    this.llmRoleName = this.getLlmRoleName(this.settings.systemPrompt || "You are a helpful assistant.");
    // this.chatLogger.updateLlmRoleName(this.llmRoleName); // ChatLoggerにメソッドがあれば
    this.initializeChatModel();
    this.contextRetriever.onSettingsChanged();

    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('memoria-chat-view-container');

    const styleEl = container.createEl('style');
    styleEl.textContent = `
      .memoria-chat-view-container { display: flex; flex-direction: column; height: 100%; }
      .memoria-chat-header { display: flex; justify-content: flex-end; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--background-modifier-border); background-color: var(--background-primary); flex-shrink: 0; }
      .memoria-chat-header button { margin-left: 8px; }
      .memoria-chat-messages-wrapper { flex-grow: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; }
      .memoria-chat-messages-inner { display: flex; flex-direction: column; }
      .memoria-chat-message { margin-bottom: 8px; padding: 8px 12px; border-radius: 12px; max-width: 85%; width: fit-content; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      .user-message { background-color: var(--interactive-accent); color: var(--text-on-accent); align-self: flex-end; }
      .model-message { background-color: var(--background-secondary); align-self: flex-start; }
      .model-message.loading { color: var(--text-muted); font-style: italic; }
      .memoria-chat-input-form { display: flex; padding: 10px; border-top: 1px solid var(--background-modifier-border); background-color: var(--background-primary); flex-shrink: 0; align-items: flex-end; }
      .memoria-chat-input-textarea { flex-grow: 1; margin-right: 8px; resize: none; font-family: inherit; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); padding: 8px; min-height: 40px; max-height: 200px; overflow-y: auto; }
      .memoria-chat-send-button { align-self: flex-end; min-height: 40px; }
    `;

    const chatHeaderEl = container.createEl('div', { cls: 'memoria-chat-header' });

    const newChatButton = chatHeaderEl.createEl('button', {
      text: 'New Chat',
      cls: 'mod-cta memoria-new-chat-button'
    });
    newChatButton.addEventListener('click', () => this.resetChat());

    const discardChatButton = chatHeaderEl.createEl('button', {
        text: 'Discard Chat',
        cls: 'mod-warning memoria-discard-chat-button'
    });
    discardChatButton.addEventListener('click', () => this.confirmAndDiscardChat());

    const messagesWrapperEl = container.createEl('div', { cls: 'memoria-chat-messages-wrapper' });
    this.chatMessagesEl = messagesWrapperEl.createEl('div', { cls: 'memoria-chat-messages-inner' });
    this.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');

    const inputFormEl = container.createEl('form', { cls: 'memoria-chat-input-form' });
    inputFormEl.addEventListener('submit', (event) => {
      event.preventDefault(); this.sendMessage();
    });

    this.inputEl = inputFormEl.createEl('textarea', {
      attr: { placeholder: 'メッセージを入力 (Shift+Enterで送信)', rows: 1 },
      cls: 'memoria-chat-input-textarea'
    });
    this.inputEl.addEventListener('input', () => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
    });
    this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault(); this.sendMessage();
      }
    });
    inputFormEl.createEl('button', {
      text: '送信', type: 'submit', cls: 'mod-cta memoria-chat-send-button'
    });

    if (!this.chainWithHistory) {
        new Notice('Geminiチャット機能が利用できません。設定（APIキー、モデル名）を確認してください。', 0);
    }
  }

  async onClose() {
    // Clean up resources if needed
  }

  private async confirmAndDiscardChat() {
    const messages = await this.messageHistory.getMessages();
    const currentLogPath = this.chatLogger.getLogFilePath();

    if (!currentLogPath && messages.length <= 1) {
        new Notice('破棄するチャットログがありません。');
        await this.resetChat(true);
        new Notice('現在のチャット（ログなし）が破棄され、新しいチャットが開始されました。');
        return;
    }

    const modal = new ConfirmationModal(
        this.app,
        'チャット履歴の破棄',
        '現在のチャット履歴を完全に破棄しますか？この操作は元に戻せません。ログファイルも削除されます。',
        async () => {
            await this.discardCurrentChatLogAndReset();
        }
    );
    modal.open();
  }

  private async discardCurrentChatLogAndReset() {
    const currentLogPath = this.chatLogger.getLogFilePath();
    if (currentLogPath) {
        await this.chatLogger.deleteLogFile(currentLogPath);
        // ChatLogger内で currentLogFilePath は null に設定される
    } else {
        console.log('[MemoriaChat] No log file path set, resetting UI and history.');
    }
    await this.resetChat(true);
    new Notice('現在のチャットが破棄され、新しいチャットが開始されました。');
  }

  private async resetChat(skipSummary = false) {
    const previousLogPath = this.chatLogger.getLogFilePath();
    const previousLlmRoleName = this.llmRoleName;

    this.chatLogger.resetLogFile(); // ログファイルパスをリセット

    if (this.chatMessagesEl) {
      this.chatMessagesEl.empty();
    }
    this.messageHistory = new ChatMessageHistory();
    this.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
    this.scrollToBottom();

    if (this.inputEl) {
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.inputEl.focus();
    }

    console.log('[MemoriaChat] Chat has been reset.');

    if (!skipSummary) {
        new Notice('新しいチャットが開始されました。');
    }

    if (!skipSummary && previousLogPath && previousLlmRoleName) {
      new Notice(`前のチャットの要約をバックグラウンドで生成開始します: ${previousLogPath}`);
      this.summaryGenerator.generateSummary(previousLogPath, previousLlmRoleName)
        .then(async (summaryNoteFile: TFile | null) => {
          if (summaryNoteFile) {
            console.log(`[MemoriaChat] Summary generation completed: ${summaryNoteFile.path}`);
            new Notice(`サマリーノートが生成されました: ${summaryNoteFile.basename}`);
            // ChatLogger を使ってログファイルのフロントマターを更新
            await this.chatLogger.updateLogFileFrontmatter(previousLogPath, {
                title: summaryNoteFile.basename.replace(/\.md$/, '').replace(/^SN-\d{12}-/, ''), // SN-YYYYMMDDHHMM-Title -> Title
                summary_note: `[[${summaryNoteFile.name}]]`
            });

            try {
              await this.tagProfiler.processSummaryNote(summaryNoteFile);
              console.log(`[MemoriaChat] Tag profiling initiated for ${summaryNoteFile.path}`);
              new Notice(`タグプロファイル処理を開始しました: ${summaryNoteFile.basename}`);
            } catch (tpError: any) {
              console.error(`[MemoriaChat] Error during tag profiling for ${summaryNoteFile.path}:`, tpError.message, tpError.stack);
              new Notice(`タグプロファイル処理中にエラーが発生しました: ${summaryNoteFile.basename}`);
            }
          } else {
            console.log(`[MemoriaChat] Summary generation for ${previousLogPath} did not return a file.`);
            new Notice(`前のチャット (${previousLogPath}) のサマリーノートファイルが取得できませんでした。`);
          }
        })
        .catch(error => {
          console.error(`[MemoriaChat] Summary generation failed for ${previousLogPath}:`, error);
          new Notice(`前のチャット (${previousLogPath}) の要約作成に失敗しました。`);
        });
    } else if (skipSummary) {
      console.log('[MemoriaChat] Summary generation skipped for previous chat.');
    }
  }

  private appendMessage(message: string, type: 'user' | 'model' | 'loading') {
    const messageEl = this.chatMessagesEl.createEl('div', {
        cls: `memoria-chat-message ${type}-message ${type === 'loading' ? 'loading' : ''}`
    });
    messageEl.setText(message);
    this.scrollToBottom();
    return messageEl;
  }

  appendUserMessage(message: string) { this.appendMessage(message, 'user'); }
  appendModelMessage(message: string) { this.appendMessage(message, 'model'); }

  scrollToBottom() {
    const wrapper = this.chatMessagesEl.parentElement;
    if (wrapper) {
      setTimeout(() => { wrapper.scrollTop = wrapper.scrollHeight; }, 50);
    }
  }

  async sendMessage() {
    const rawMessageContent = this.inputEl.value;
    const trimmedMessageContent = rawMessageContent.trim();

    if (!trimmedMessageContent) {
      if (rawMessageContent.length > 0) new Notice("メッセージが空白です。送信は行いません。");
      this.inputEl.value = ''; this.inputEl.style.height = 'auto'; this.inputEl.focus();
      return;
    }

    const messages = await this.messageHistory.getMessages();
    const userMessageCount = messages.filter(msg => msg._getType() === "human").length;
    const isFirstActualUserMessage = userMessageCount === 0;

    if (!this.chatLogger.getLogFilePath()) {
        // llmRoleName を最新の状態で渡す
        const currentLlmRoleName = this.getLlmRoleName(this.settings.systemPrompt || "You are a helpful assistant.");
        await this.chatLogger.setupLogFile(currentLlmRoleName);
        if (!this.chatLogger.getLogFilePath()) {
            this.appendModelMessage('エラー: ログファイルの作成に失敗したため、メッセージを送信できません。');
            new Notice('ログファイルの作成に失敗しました。');
            return;
        }
    }

    this.appendUserMessage(trimmedMessageContent);
    await this.chatLogger.appendLogEntry(`**User**: ${trimmedMessageContent}\n`);

    this.inputEl.value = ''; this.inputEl.style.height = 'auto'; this.inputEl.focus();

    if (!this.chainWithHistory) {
      this.appendModelMessage('エラー: チャットチェーンが初期化されていません。プラグイン設定を確認してください。');
      new Notice('チャット機能が利用できません。設定を確認してください。');
      this.initializeChatModel();
      if(!this.chainWithHistory) return;
    }

    const loadingMessageEl = this.appendMessage('応答を待っています...', 'loading');

    let retrievedContextString = "記憶からの関連情報は見つかりませんでした。";
    try {
        const currentChatHistoryMessages = await this.messageHistory.getMessages();
        const retrievedContextResult: RetrievedContext = await this.contextRetriever.retrieveContextForPrompt(
            trimmedMessageContent,
            this.llmRoleName,
            currentChatHistoryMessages
        );

        if (retrievedContextResult.llmContextPrompt && retrievedContextResult.llmContextPrompt.trim() !== "") {
            retrievedContextString = retrievedContextResult.llmContextPrompt;
        }
    } catch (contextError: any) {
        console.error('[MemoriaChat] Error retrieving context:', contextError.message, contextError.stack);
        new Notice('記憶情報の取得中にエラーが発生しました。デフォルトのコンテキストを使用します。');
    }

    const currentTime = moment().format('YYYY-MM-DD HH:mm:ss dddd');
    let currentLocationString = "現在地の取得に失敗しました。";
    let currentWeatherString = "天気情報の取得に失敗しました。";

    if (isFirstActualUserMessage) {
        try {
            const contextualInfo: CurrentContextualInfo | null = await this.locationFetcher.fetchCurrentContextualInfo();
            if (contextualInfo) {
                if (contextualInfo.location) {
                    const loc = contextualInfo.location;
                    currentLocationString = `現在のあなたの推定位置は、都市: ${loc.city || '不明'}, 地域: ${loc.regionName || '不明'}, 国: ${loc.country || '不明'} (タイムゾーン: ${loc.timezone || '不明'}) です。`;
                    if (this.plugin.settings.showLocationInChat) {
                        new Notice(`現在地: ${loc.city || '不明'}, ${loc.country || '不明'}`, 3000);
                    }
                } else if (contextualInfo.error?.includes('位置情報')) {
                     currentLocationString = contextualInfo.error;
                }

                if (contextualInfo.weather) {
                    const weather = contextualInfo.weather;
                    currentWeatherString = `現地の天気は ${weather.description || '不明'}、気温 ${weather.temperature?.toFixed(1) ?? '不明'}℃、体感温度 ${weather.apparent_temperature?.toFixed(1) ?? '不明'}℃、湿度 ${weather.humidity ?? '不明'}%、風速 ${weather.windspeed?.toFixed(1) ?? '不明'}m/s です。(情報取得時刻: ${weather.time || '不明'})`;
                     if (this.plugin.settings.showWeatherInChat) {
                        new Notice(`天気: ${weather.description || '不明'} ${weather.temperature?.toFixed(1) ?? '?'}℃`, 3000);
                    }
                } else if (contextualInfo.error?.includes('天気情報')) {
                    currentWeatherString = contextualInfo.error.replace(currentLocationString, '').trim();
                    if (currentWeatherString === "") currentWeatherString = "天気情報の取得に失敗しました。";
                }
            }
            console.log(`[MemoriaChat] Location for first message: ${currentLocationString}`);
            console.log(`[MemoriaChat] Weather for first message: ${currentWeatherString}`);
        } catch (contextualError: any) {
            console.error('[MemoriaChat] Error fetching contextual info for first message:', contextualError.message);
            currentLocationString = "現在地の取得中に全体的なエラーが発生しました。";
            currentWeatherString = "天気情報の取得中に全体的なエラーが発生しました。";
        }
    } else {
        currentLocationString = "（現在地情報は最初のメッセージでのみ提供されます）";
        currentWeatherString = "（天気情報は最初のメッセージでのみ提供されます）";
    }

    try {
      const characterSettingPrompt = this.settings.systemPrompt || "あなたは親切なアシスタントです。";
      const baseRolePlayRulesForLog = `LLMキャラクターロールプレイ ルール...（省略）...---キャラクター設定:${characterSettingPrompt}---`; // 実際には省略しない
      const currentTimeInstructionForLog = `Current time is ${currentTime}...`;
      const locationInstructionForLog = `## 現在の推定位置情報 (Current Estimated Location Information):${currentLocationString}...`;
      const weatherInstructionForLog = `## 現地の現在の天気情報 (Current Local Weather Information):${currentWeatherString}...`;
      const memoryContextInstructionForLog = `## 記憶からの参考情報 (Memory Recall Information):${retrievedContextString}...指示...`;
      // const effectiveSystemPromptForLogging = currentTimeInstructionForLog + locationInstructionForLog + weatherInstructionForLog + baseRolePlayRulesForLog + memoryContextInstructionForLog;
      // console.log("[MemoriaChat] Effective system prompt content being prepared for LLM:", effectiveSystemPromptForLogging); // ログ出力は必要に応じて

      const chainInput = {
        input: trimmedMessageContent,
        retrieved_context_string: retrievedContextString,
        current_time: currentTime,
        current_location_string: currentLocationString,
        current_weather_string: currentWeatherString,
      };
      // console.log("[MemoriaChat] Invoking chain with input:", JSON.stringify(chainInput, null, 2)); // ログ出力は必要に応じて

      const response = await this.chainWithHistory.invoke(
        chainInput,
        { configurable: { sessionId: "obsidian-memoria-session" } }
      );
      loadingMessageEl.remove();
      let responseText = '';

      if (response && typeof response.content === 'string') {
        responseText = response.content;
      } else if (response && Array.isArray(response.content) && response.content.length > 0 && typeof response.content[0] === 'object' && response.content[0] !== null && 'text' in response.content[0]) {
        responseText = (response.content[0] as any).text;
      } else {
        console.error('[MemoriaChat] Invalid response format:', response);
        responseText = 'エラー: 予期しない形式の応答がありました。';
      }
      this.appendModelMessage(responseText);
      await this.chatLogger.appendLogEntry(`**${this.llmRoleName}**: ${responseText}\n`);

    } catch (error: any) {
      console.error('[MemoriaChat] Error sending message:', error.message, error.stack);
      loadingMessageEl.remove();
      let errorMessage = 'エラー: メッセージの送信中に問題が発生しました。';
      if (error.message) errorMessage += `\n詳細: ${error.message}`;
      this.appendModelMessage(errorMessage);
      new Notice(`チャットエラー: ${error.message || '不明なエラー'}`);
      await this.chatLogger.appendLogEntry(`**${this.llmRoleName}**: (エラー発生) ${error.message || '不明なエラー'}\n`);
    } finally {
      this.scrollToBottom();
    }
  }
}
