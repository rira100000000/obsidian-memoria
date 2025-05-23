// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice, moment, TFile, App } from 'obsidian'; // Modal, Setting は ChatUIManager に移動
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
import { ChatLogger } from '../chatLogger';
import { ChatUIManager, ConfirmationModal } from './chatUIManager'; // ChatUIManager と ConfirmationModal をインポート

export const CHAT_VIEW_TYPE = 'obsidian-memoria-chat-view';

export class ChatView extends ItemView {
  plugin: ObsidianMemoria;
  settings: GeminiPluginSettings;
  // chatMessagesEl: HTMLElement; // ChatUIManagerが管理
  // inputEl: HTMLTextAreaElement; // ChatUIManagerが管理
  private uiManager!: ChatUIManager; // UIマネージャーのインスタンスを保持

  private messageHistory = new ChatMessageHistory();
  private chatModel: ChatGoogleGenerativeAI | null = null;
  private chainWithHistory: RunnableWithMessageHistory<Record<string, any>, BaseMessage> | null = null;
  private contextRetriever: ContextRetriever;
  private locationFetcher: LocationFetcher;
  private chatLogger: ChatLogger;

  private llmRoleName = 'Assistant';
  private summaryGenerator: SummaryGenerator;
  private tagProfiler: TagProfiler;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.llmRoleName = this.getLlmRoleName(this.settings.systemPrompt || "You are a helpful assistant.");
    this.chatLogger = new ChatLogger(this.app, this.llmRoleName);
    this.summaryGenerator = new SummaryGenerator(this.plugin);
    this.tagProfiler = new TagProfiler(this.plugin);
    this.contextRetriever = new ContextRetriever(this.plugin);
    this.locationFetcher = new LocationFetcher(this.plugin);
  }

  private getLlmRoleName(systemPrompt: string): string {
    if (!systemPrompt) return 'Assistant';
    let match;
    match = systemPrompt.match(/named\s+([\w\s-]+)(?:\.|$|,|;)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/Your name is\s+([\w\s-]+)(?:\.|$|,|;)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/Your role is\s+([\w\s-]+)(?:\.|$|,|;)/i);
    if (match && match[1]) return match[1].trim();
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

    const baseRolePlayRules = `LLMキャラクターロールプレイ ルール...（省略）...---キャラクター設定:${characterSettingPrompt}---`; // 実際には省略しない
    const currentTimeInstruction = `Current time is {current_time}...`;
    const locationInstruction = `## 現在の推定位置情報 (Current Estimated Location Information):{current_location_string}...`;
    const weatherInstruction = `## 現地の現在の天気情報 (Current Local Weather Information):{current_weather_string}...`;
    const memoryContextInstruction = `## 記憶からの参考情報 (Memory Recall Information):{retrieved_context_string}...指示...`;
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
    this.initializeChatModel();
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
    this.initializeChatModel();
    this.contextRetriever.onSettingsChanged();

    // ChatUIManagerの初期化とUI構築
    // this.containerEl.children[1] は ItemView の .view-content を指す
    this.uiManager = new ChatUIManager(
        this.containerEl.children[1] as HTMLElement,
        () => this.sendMessage(),
        () => this.resetChat(),
        () => this.confirmAndDiscardChat()
    );
    this.uiManager.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');

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

    const modal = new ConfirmationModal( // ChatUIManagerからインポートしたConfirmationModalを使用
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
    } else {
        console.log('[MemoriaChat] No log file path set, resetting UI and history.');
    }
    await this.resetChat(true);
    new Notice('現在のチャットが破棄され、新しいチャットが開始されました。');
  }

  private async resetChat(skipSummary = false) {
    const previousLogPath = this.chatLogger.getLogFilePath();
    const previousLlmRoleName = this.llmRoleName;

    this.chatLogger.resetLogFile();

    if (this.uiManager) { // uiManagerが初期化されていれば使用
        this.uiManager.clearMessages();
        this.uiManager.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
        this.uiManager.resetInputField();
        this.uiManager.scrollToBottom();
    }
    this.messageHistory = new ChatMessageHistory();


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
            await this.chatLogger.updateLogFileFrontmatter(previousLogPath, {
                title: summaryNoteFile.basename.replace(/\.md$/, '').replace(/^SN-\d{12}-/, ''),
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

  async sendMessage() {
    if (!this.uiManager) return; // UIマネージャーがなければ何もしない

    const rawMessageContent = this.uiManager.getInputText();
    const trimmedMessageContent = rawMessageContent.trim();

    if (!trimmedMessageContent) {
      if (rawMessageContent.length > 0) new Notice("メッセージが空白です。送信は行いません。");
      this.uiManager.resetInputField();
      return;
    }

    const messages = await this.messageHistory.getMessages();
    const userMessageCount = messages.filter(msg => msg._getType() === "human").length;
    const isFirstActualUserMessage = userMessageCount === 0;

    if (!this.chatLogger.getLogFilePath()) {
        const currentLlmRoleName = this.getLlmRoleName(this.settings.systemPrompt || "You are a helpful assistant.");
        await this.chatLogger.setupLogFile(currentLlmRoleName);
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
      const chainInput = {
        input: trimmedMessageContent,
        retrieved_context_string: retrievedContextString,
        current_time: currentTime,
        current_location_string: currentLocationString,
        current_weather_string: currentWeatherString,
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
