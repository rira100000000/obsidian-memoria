// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice, moment, TFile, App } from 'obsidian';
import ObsidianMemoria from '../../main';
import { GeminiPluginSettings, DEFAULT_SETTINGS } from '../settings';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate
} from "@langchain/core/prompts";
// import { SummaryGenerator } from '../summaryGenerator'; // SummaryGenerator は不要になったためコメントアウト
import { TagProfiler } from '../tagProfiler';
import { ContextRetriever } from '../contextRetriever';
import { LocationFetcher } from '../locationFetcher';
import { ChatLogger } from '../chatLogger';
import { ChatUIManager } from './chatUIManager';
import { ChatSessionManager } from '../chatSessionManager';
import { PromptFormatter } from '../promptFormatter';
import { ChatContextBuilder, LlmContextInput } from '../chatContextBuilder';

export const CHAT_VIEW_TYPE = 'obsidian-memoria-chat-view';

export class ChatView extends ItemView {
  plugin: ObsidianMemoria;
  settings: GeminiPluginSettings;
  private uiManager!: ChatUIManager;
  private chatSessionManager!: ChatSessionManager;
  private promptFormatter!: PromptFormatter;
  private chatContextBuilder!: ChatContextBuilder;

  private chatModel: ChatGoogleGenerativeAI | null = null;
  private chainWithHistory: RunnableWithMessageHistory<Record<string, any>, BaseMessage> | null = null;
  private contextRetriever: ContextRetriever;
  private locationFetcher: LocationFetcher;
  private chatLogger!: ChatLogger;

  private llmRoleName: string;
  // private summaryGenerator: SummaryGenerator; // 不要になったためコメントアウト
  private tagProfiler: TagProfiler;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;

    // this.summaryGenerator = new SummaryGenerator(this.plugin); // 不要になったためコメントアウト
    this.tagProfiler = new TagProfiler(this.plugin);
    this.contextRetriever = new ContextRetriever(this.plugin);
    this.locationFetcher = new LocationFetcher(this.plugin);
    this.promptFormatter = new PromptFormatter(this.settings);
    this.chatContextBuilder = new ChatContextBuilder(
        this.contextRetriever,
        this.locationFetcher,
        this.settings
    );
  }

  private initializeChatModel() {
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;

    this.promptFormatter.updateSettings(this.settings);
    this.chatContextBuilder.onSettingsChanged(this.settings);
    if (this.chatLogger) {
        this.chatLogger = new ChatLogger(this.app, this.llmRoleName);
    }

    if (this.chatSessionManager) {
        this.chatSessionManager.updateLlmRoleName(this.llmRoleName);
    }

    const systemPromptTemplateString = this.promptFormatter.getSystemPromptTemplate();

    if (this.settings.geminiApiKey && this.settings.geminiModel) {
      try {
        this.chatModel = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: this.settings.geminiModel,
        });

        const systemMessagePrompt = SystemMessagePromptTemplate.fromTemplate(systemPromptTemplateString);
        const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate("{input}");

        const prompt = ChatPromptTemplate.fromMessages([
          systemMessagePrompt,
          new MessagesPlaceholder("history"),
          humanMessagePrompt,
        ]);

        const chain = prompt.pipe(this.chatModel);
        this.chainWithHistory = new RunnableWithMessageHistory({
            runnable: chain,
            getMessageHistory: (_sessionId) => this.chatSessionManager.messageHistory,
            inputMessagesKey: "input",
            historyMessagesKey: "history",
        });
        console.log(`[MemoriaChat] Chat model initialized. LLM Role: ${this.llmRoleName}`);
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
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;

    this.initializeChatModel();

    if (this.chatSessionManager) {
        this.chatSessionManager.updateLlmRoleName(this.llmRoleName);
    }
    if (this.chatLogger) {
        this.chatLogger = new ChatLogger(this.app, this.llmRoleName);
    } else {
        this.chatLogger = new ChatLogger(this.app, this.llmRoleName);
    }

    // this.summaryGenerator.onSettingsChanged(); // 不要になったためコメントアウト
    this.tagProfiler.onSettingsChanged();
    this.contextRetriever.onSettingsChanged();
    this.locationFetcher.onSettingsChanged(this.settings);

    this.updateTitle();
    console.log('[MemoriaChat] Settings changed, relevant modules re-initialized/updated.');
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return `Memoria Chat (${this.llmRoleName || '...'})`; }
  getIcon() { return 'messages-square'; }

  async onOpen() {
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;

    this.chatLogger = new ChatLogger(this.app, this.llmRoleName);

    this.promptFormatter.updateSettings(this.settings);
    this.chatContextBuilder.onSettingsChanged(this.settings);

    this.uiManager = new ChatUIManager(
        this.containerEl.children[1] as HTMLElement,
        () => this.sendMessage(),
        () => this.chatSessionManager.resetChat(false), // skipSummaryAndReflection は resetChat のデフォルト値に依存
        () => this.chatSessionManager.confirmAndDiscardChat()
    );

    this.chatSessionManager = new ChatSessionManager(
        this.app,
        this.plugin,
        this.uiManager,
        this.chatLogger,
        // this.summaryGenerator, // 引数から削除
        this.tagProfiler,
        this.llmRoleName
    );

    this.initializeChatModel();
    this.contextRetriever.onSettingsChanged();
    this.locationFetcher.onSettingsChanged(this.settings);

    this.uiManager.appendModelMessage(`チャットウィンドウへようこそ！ ${this.llmRoleName}がお話しします。\nShift+Enterでメッセージを送信します。`);

    if (!this.chainWithHistory) {
        new Notice('Geminiチャット機能が利用できません。設定（APIキー、モデル名）を確認してください。', 0);
    }
    this.updateTitle();
  }

  async onClose() {
    // Clean up resources if needed
  }

  private updateTitle() {
    console.log(`[MemoriaChat] updateTitle called. Display text relies on getDisplayText(): ${this.getDisplayText()}`);
  }


  async sendMessage() {
    if (!this.uiManager || !this.chatSessionManager || !this.promptFormatter || !this.chatContextBuilder || !this.chatLogger) {
        console.error("[MemoriaChat] sendMessage preconditions not met. One or more managers are undefined.");
        new Notice("チャットの送信準備ができていません。");
        return;
    }

    const rawMessageContent = this.uiManager.getInputText();
    const trimmedMessageContent = rawMessageContent.trim();

    if (!trimmedMessageContent) {
      if (rawMessageContent.length > 0) new Notice("メッセージが空白です。送信は行いません。");
      this.uiManager.resetInputField();
      return;
    }

    const messages = await this.chatSessionManager.getMessages();
    const userMessageCount = messages.filter(msg => msg._getType() === "human").length;
    const isFirstActualUserMessage = userMessageCount === 0;

    if (!this.chatLogger.getLogFilePath()) {
        await this.chatLogger.setupLogFile(this.llmRoleName);
        if (!this.chatLogger.getLogFilePath()) {
            this.uiManager.appendModelMessage('エラー: ログファイルの作成に失敗したため、メッセージを送信できません。');
            new Notice('ログファイルの作成に失敗しました。');
            return;
        }
    }

    this.uiManager.appendUserMessage(trimmedMessageContent);
    await this.chatLogger.appendLogEntry(`**User**: ${trimmedMessageContent}\n`);
    this.uiManager.resetInputField();

    if (!this.chainWithHistory) {
      this.uiManager.appendModelMessage('エラー: チャットチェーンが初期化されていません。プラグイン設定を確認してください。');
      new Notice('チャット機能が利用できません。設定を確認してください。');
      this.initializeChatModel();
      if(!this.chainWithHistory) return;
    }

    const loadingMessageEl = this.uiManager.appendMessage('応答を待っています...', 'loading');

    let llmContext: LlmContextInput;
    try {
        llmContext = await this.chatContextBuilder.prepareContextForLlm(
            trimmedMessageContent,
            this.llmRoleName,
            await this.chatSessionManager.getMessages(),
            isFirstActualUserMessage
        );
        if (isFirstActualUserMessage) {
            if (this.settings.showLocationInChat && llmContext.current_location_string && !llmContext.current_location_string.includes("失敗") && !llmContext.current_location_string.includes("最初のメッセージでのみ")) {
                new Notice(`現在地情報がLLMに渡されました。`, 3000);
            }
            if (this.settings.showWeatherInChat && llmContext.current_weather_string && !llmContext.current_weather_string.includes("失敗") && !llmContext.current_weather_string.includes("最初のメッセージでのみ")) {
                new Notice(`天気情報がLLMに渡されました。`, 3000);
            }
        }

    } catch (error: any) {
        console.error('[MemoriaChat] Error preparing context via ChatContextBuilder:', error.message, error.stack);
        new Notice('LLMへのコンテキスト準備中にエラーが発生しました。');
        llmContext = {
            character_setting_prompt: this.settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt,
            retrieved_context_string: "記憶からの関連情報は見つかりませんでした。",
            current_time: moment().format('YYYY-MM-DD HH:mm:ss dddd'),
            current_location_string: "現在地の取得に失敗しました。",
            current_weather_string: "天気情報の取得に失敗しました。",
        };
    }


    try {
      const chainInput = {
        input: trimmedMessageContent,
        character_setting_prompt: llmContext.character_setting_prompt,
        retrieved_context_string: llmContext.retrieved_context_string,
        current_time: llmContext.current_time,
        current_location_string: llmContext.current_location_string,
        current_weather_string: llmContext.current_weather_string,
      };

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
      this.uiManager.appendModelMessage(responseText);
      await this.chatLogger.appendLogEntry(`**${this.llmRoleName}**: ${responseText}\n`);

    } catch (error: any) {
      console.error('[MemoriaChat] Error sending message:', error.message, error.stack);
      loadingMessageEl.remove();
      let errorMessage = 'エラー: メッセージの送信中に問題が発生しました。';
      if (error.message) errorMessage += `\n詳細: ${error.message}`;
      this.uiManager.appendModelMessage(errorMessage);
      new Notice(`チャットエラー: ${error.message || '不明なエラー'}`);
      await this.chatLogger.appendLogEntry(`**${this.llmRoleName}**: (エラー発生) ${error.message || '不明なエラー'}\n`);
    } finally {
      this.uiManager.scrollToBottom();
    }
  }
}
