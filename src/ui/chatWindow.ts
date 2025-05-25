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
  private chatLogger!: ChatLogger; // ChatLogger のインスタンスを保持

  private llmRoleName: string;
  // private summaryGenerator: SummaryGenerator; // 不要になったためコメントアウト
  private tagProfiler: TagProfiler;
  private viewInstanceId: string; // デバッグ用のビューインスタンスID

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;
    this.viewInstanceId = Math.random().toString(36).substring(2, 8);
    console.log(`[ChatView][${this.viewInstanceId}] Constructor called. Initial RoleName: ${this.llmRoleName}`);

    // ChatLogger の初期化は onOpen で行う
    // this.chatLogger = new ChatLogger(this.app, this.llmRoleName);

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
    console.log(`[ChatView][${this.viewInstanceId}] initializeChatModel called.`);
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;

    this.promptFormatter.updateSettings(this.settings);
    this.chatContextBuilder.onSettingsChanged(this.settings);
    
    // ChatLogger は onSettingsChanged または onOpen でインスタンスが管理される
    // ChatSessionManager も同様

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
        
        // getMessageHistory が ChatSessionManager のインスタンスメソッドを参照するようにする
        // ChatSessionManager が初期化された後に chainWithHistory を設定する必要がある
        if (this.chatSessionManager) {
            this.chainWithHistory = new RunnableWithMessageHistory({
                runnable: chain,
                getMessageHistory: (_sessionId) => this.chatSessionManager.messageHistory,
                inputMessagesKey: "input",
                historyMessagesKey: "history",
            });
            console.log(`[ChatView][${this.viewInstanceId}] Chat model and chainWithHistory initialized. LLM Role: ${this.llmRoleName}`);
        } else {
            console.warn(`[ChatView][${this.viewInstanceId}] chatSessionManager not yet initialized. chainWithHistory will be set up later.`);
            // chainWithHistory は onOpen の最後や sendMessage の直前で再確認・再設定が必要になる場合がある
        }
      } catch (error: any) {
        console.error(`[ChatView][${this.viewInstanceId}] Failed to initialize ChatGoogleGenerativeAI model or chain:`, error.message);
        new Notice('Geminiモデルまたはチャットチェーンの初期化に失敗しました。');
        this.chatModel = null;
        this.chainWithHistory = null;
      }
    } else {
      console.log(`[ChatView][${this.viewInstanceId}] API key or model name not set. Chat model not initialized.`);
      this.chatModel = null;
      this.chainWithHistory = null;
    }
  }

  onSettingsChanged() {
    console.log(`[ChatView][${this.viewInstanceId}] onSettingsChanged called.`);
    const oldRoleName = this.llmRoleName;
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;
    console.log(`[ChatView][${this.viewInstanceId}] RoleName changed from '${oldRoleName}' to '${this.llmRoleName}'`);

    // ChatLogger を新しい設定 (特に llmRoleName) で再初期化
    // 以前の chatLogger インスタンスがあった場合、その ID もログに出力
    const oldChatLoggerId = this.chatLogger ? (this.chatLogger as any).instanceId : 'N/A';
    this.chatLogger = new ChatLogger(this.app, this.llmRoleName);
    console.log(`[ChatView][${this.viewInstanceId}] ChatLogger re-initialized. Old ID: ${oldChatLoggerId}, New ID: ${(this.chatLogger as any).instanceId}`);

    // initializeChatModel は ChatSessionManager ができてから呼ぶ方が安全
    // ChatSessionManager も新しい ChatLogger を参照するように更新
    if (this.chatSessionManager) {
        this.chatSessionManager.updateLlmRoleName(this.llmRoleName);
        this.chatSessionManager.updateChatLogger(this.chatLogger);
    } else {
        console.warn(`[ChatView][${this.viewInstanceId}] onSettingsChanged: chatSessionManager not yet initialized. Updates will be applied upon its creation.`);
    }
    
    // initializeChatModel は chainWithHistory を再生成する可能性があり、
    // chainWithHistory は chatSessionManager.messageHistory を参照するため、
    // chatSessionManager が確実に存在し、更新された後に呼ぶのが望ましい。
    this.initializeChatModel(); // LLMモデルとチェーンを再初期化 (ChatSessionManager の依存関係を考慮)


    this.tagProfiler.onSettingsChanged();
    this.contextRetriever.onSettingsChanged();
    this.locationFetcher.onSettingsChanged(this.settings);
    this.chatContextBuilder.onSettingsChanged(this.settings);

    this.updateTitle();
    console.log(`[ChatView][${this.viewInstanceId}] Settings changed, relevant modules re-initialized/updated.`);
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return `Memoria Chat (${this.llmRoleName || '...'})`; }
  getIcon() { return 'messages-square'; }

  async onOpen() {
    console.log(`[ChatView][${this.viewInstanceId}] onOpen called.`);
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;
    console.log(`[ChatView][${this.viewInstanceId}] RoleName set to: ${this.llmRoleName}`);

    // ChatLogger の初期化 (コンストラクタから移動)
    this.chatLogger = new ChatLogger(this.app, this.llmRoleName);
    console.log(`[ChatView][${this.viewInstanceId}] ChatLogger initialized in onOpen. ID: ${(this.chatLogger as any).instanceId}`);

    this.promptFormatter.updateSettings(this.settings);
    this.chatContextBuilder.onSettingsChanged(this.settings);
    this.locationFetcher.onSettingsChanged(this.settings);
    this.contextRetriever.onSettingsChanged();
    this.tagProfiler.onSettingsChanged();


    this.uiManager = new ChatUIManager(
        this.containerEl.children[1] as HTMLElement,
        () => this.sendMessage(),
        () => this.chatSessionManager.resetChat(false),
        () => this.chatSessionManager.confirmAndDiscardChat()
    );
    console.log(`[ChatView][${this.viewInstanceId}] UIManager initialized.`);

    this.chatSessionManager = new ChatSessionManager(
        this.app,
        this.plugin,
        this.uiManager,
        this.chatLogger, // ここで初期化済みの chatLogger を渡す
        this.tagProfiler,
        this.llmRoleName
    );
    console.log(`[ChatView][${this.viewInstanceId}] ChatSessionManager initialized, passing ChatLogger ID: ${(this.chatLogger as any).instanceId}`);

    // ChatSessionManager が初期化された後に initializeChatModel を呼ぶ
    this.initializeChatModel(); 

    this.uiManager.appendModelMessage(`チャットウィンドウへようこそ！ ${this.llmRoleName}がお話しします。\nShift+Enterでメッセージを送信します。`);

    if (!this.chainWithHistory && this.settings.geminiApiKey && this.settings.geminiModel) {
        // initializeChatModel で chainWithHistory が設定されなかった場合のフォールバックまたは警告
        console.warn(`[ChatView][${this.viewInstanceId}] chainWithHistory is still null after onOpen initializations. This might indicate an issue if API key and model are set.`);
        new Notice('チャットモデルの接続に問題がある可能性があります。設定を確認してください。', 0);
    } else if (!this.settings.geminiApiKey || !this.settings.geminiModel) {
        new Notice('Geminiチャット機能が利用できません。設定（APIキー、モデル名）を確認してください。', 0);
    }
    this.updateTitle();
  }

  async onClose() {
    console.log(`[ChatView][${this.viewInstanceId}] onClose called.`);
    // Clean up resources if needed
  }

  private updateTitle() {
    const newDisplayText = this.getDisplayText();
    console.log(`[ChatView][${this.viewInstanceId}] updateTitle called. Current display text: ${newDisplayText}`);
  }


  async sendMessage() {
    console.log(`[ChatView][${this.viewInstanceId}] sendMessage called.`);
    if (!this.uiManager || !this.chatSessionManager || !this.promptFormatter || !this.chatContextBuilder || !this.chatLogger) {
        console.error(`[ChatView][${this.viewInstanceId}] sendMessage preconditions not met. UIManager: ${!!this.uiManager}, ChatSessionManager: ${!!this.chatSessionManager}, PromptFormatter: ${!!this.promptFormatter}, ChatContextBuilder: ${!!this.chatContextBuilder}, ChatLogger: ${!!this.chatLogger} (ID: ${this.chatLogger ? (this.chatLogger as any).instanceId : 'N/A'})`);
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
    console.log(`[ChatView][${this.viewInstanceId}] isFirstActualUserMessage: ${isFirstActualUserMessage}`);

    // ログファイルパスの確認とセットアップ
    let currentLogPath = this.chatLogger.getLogFilePath();
    console.log(`[ChatView][${this.viewInstanceId}] Before setupLogFile check. Current log path from ChatLogger ID ${(this.chatLogger as any).instanceId}: ${currentLogPath}`);
    if (!currentLogPath) {
        console.log(`[ChatView][${this.viewInstanceId}] Log file path is null, calling setupLogFile with RoleName: ${this.llmRoleName}`);
        await this.chatLogger.setupLogFile(this.llmRoleName);
        currentLogPath = this.chatLogger.getLogFilePath(); // 再取得
        console.log(`[ChatView][${this.viewInstanceId}] After setupLogFile. New log path: ${currentLogPath}`);
        if (!currentLogPath) {
            this.uiManager.appendModelMessage('エラー: ログファイルの作成に失敗したため、メッセージを送信できません。');
            new Notice('ログファイルの作成に失敗しました。');
            return;
        }
    }

    this.uiManager.appendUserMessage(trimmedMessageContent);
    await this.chatLogger.appendLogEntry(`**User**: ${trimmedMessageContent}\n`);
    this.uiManager.resetInputField();

    if (!this.chainWithHistory) {
      console.warn(`[ChatView][${this.viewInstanceId}] chainWithHistory is null before sending message. Attempting re-initialization.`);
      this.uiManager.appendModelMessage('エラー: チャットチェーンが初期化されていません。プラグイン設定を確認してください。');
      new Notice('チャット機能が利用できません。設定を確認してください。');
      this.initializeChatModel(); 
      if(!this.chainWithHistory) {
          console.error(`[ChatView][${this.viewInstanceId}] Re-initialization of chainWithHistory failed.`);
          return;
      }
      console.log(`[ChatView][${this.viewInstanceId}] chainWithHistory re-initialized successfully.`);
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
        console.error(`[ChatView][${this.viewInstanceId}] Error preparing context via ChatContextBuilder:`, error.message, error.stack);
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
      console.log(`[ChatView][${this.viewInstanceId}] Invoking chainWithHistory with input:`, { ...chainInput, retrieved_context_string: chainInput.retrieved_context_string.substring(0,100)+"..."});


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
        console.error(`[ChatView][${this.viewInstanceId}] Invalid response format:`, response);
        responseText = 'エラー: 予期しない形式の応答がありました。';
      }
      this.uiManager.appendModelMessage(responseText);
      await this.chatLogger.appendLogEntry(`**${this.llmRoleName}**: ${responseText}\n`);

    } catch (error: any) {
      console.error(`[ChatView][${this.viewInstanceId}] Error sending message:`, error.message, error.stack);
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