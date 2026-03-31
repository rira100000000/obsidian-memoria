// src/chatContextBuilder.ts
import { moment } from 'obsidian';
import { ContextRetriever, RetrievedContext } from './core/contextRetriever';
import { LocationFetcher } from './locationFetcher';
import { CurrentContextualInfo, ProcessingCallbacks, MemoriaMessage } from './core/types';
import { GeminiPluginSettings } from './settings';
import { ContextLayout, DEFAULT_LAYOUT, calculateBudget, fitWithinBudget } from './core/contextLayout';
import { NarrativeBuffer } from './core/narrativeBuffer';

/**
 * LLMに渡すためのコンテキスト情報をまとめたインターフェース
 */
export interface LlmContextInput {
  character_setting_prompt: string;
  retrieved_context_string: string;
  narrative_summary: string;
  current_time: string;
  current_location_string: string;
  current_weather_string: string;
  working_memory_messages: MemoriaMessage[];
}

/**
 * ChatContextBuilderクラス
 * LLMに渡すコンテキスト情報（記憶、天気、時刻など）の収集と整形を担当します。
 */
export class ChatContextBuilder {
  private contextRetriever: ContextRetriever;
  private locationFetcher: LocationFetcher;
  private settings: GeminiPluginSettings;
  private layout: ContextLayout;

  constructor(
    contextRetriever: ContextRetriever,
    locationFetcher: LocationFetcher,
    settings: GeminiPluginSettings
  ) {
    this.contextRetriever = contextRetriever;
    this.locationFetcher = locationFetcher;
    this.settings = settings;
    this.layout = DEFAULT_LAYOUT;
  }

  public onSettingsChanged(newSettings: GeminiPluginSettings): void {
    this.settings = newSettings;
  }

  public async prepareContextForLlm(
    userInput: string,
    llmRoleName: string,
    chatHistory: MemoriaMessage[],
    isFirstActualUserMessage: boolean,
    narrativeBuffer?: NarrativeBuffer,
    callbacks?: ProcessingCallbacks
  ): Promise<LlmContextInput> {
    const totalBudget = this.settings.maxContextLength || 100000;
    const budget = calculateBudget(totalBudget, this.layout);

    let retrievedContextString = "記憶からの関連情報は見つかりませんでした。";
    callbacks?.onProgress?.('記憶を検索しています...');
    try {
      const retrievedContextResult: RetrievedContext = await this.contextRetriever.retrieveContextForPrompt(
        userInput,
        llmRoleName,
        chatHistory,
        callbacks
      );
      if (retrievedContextResult.llmContextPrompt && retrievedContextResult.llmContextPrompt.trim() !== "") {
        retrievedContextString = fitWithinBudget(retrievedContextResult.llmContextPrompt, budget.memory);
      }
    } catch (contextError: any) {
      console.error('[ChatContextBuilder] Error retrieving context:', contextError.message, contextError.stack);
    }

    let narrativeSummary = '';
    let workingMemoryMessages: MemoriaMessage[] = chatHistory;

    if (narrativeBuffer) {
      narrativeSummary = narrativeBuffer.getNarrativeSummary();
      if (narrativeSummary) {
        narrativeSummary = fitWithinBudget(narrativeSummary, budget.narrative);
      }
      workingMemoryMessages = narrativeBuffer.getWorkingMemoryMessages(chatHistory);
    }

    const currentTime = moment().format('YYYY-MM-DD HH:mm:ss dddd');
    let currentLocationString = "現在地の取得に失敗しました。";
    let currentWeatherString = "天気情報の取得に失敗しました。";

    if (isFirstActualUserMessage) {
      callbacks?.onProgress?.('位置情報・天気情報を取得しています...');
      try {
        const contextualInfo: CurrentContextualInfo | null = await this.locationFetcher.fetchCurrentContextualInfo();
        if (contextualInfo) {
          if (contextualInfo.location) {
            const loc = contextualInfo.location;
            currentLocationString = `現在のあなたの推定位置は、都市: ${loc.city || '不明'}, 地域: ${loc.regionName || '不明'}, 国: ${loc.country || '不明'} (タイムゾーン: ${loc.timezone || '不明'}) です。`;
          } else if (contextualInfo.error?.includes('位置情報')) {
            currentLocationString = contextualInfo.error;
          }

          if (contextualInfo.weather) {
            const weather = contextualInfo.weather;
            currentWeatherString = `現地の天気は ${weather.description || '不明'}、気温 ${weather.temperature?.toFixed(1) ?? '不明'}℃、体感温度 ${weather.apparent_temperature?.toFixed(1) ?? '不明'}℃、湿度 ${weather.humidity ?? '不明'}%、風速 ${weather.windspeed?.toFixed(1) ?? '不明'}m/s です。(情報取得時刻: ${weather.time || '不明'})`;
          } else if (contextualInfo.error?.includes('天気情報')) {
            const weatherErrorMsg = contextualInfo.error.replace(currentLocationString, '').trim();
            currentWeatherString = weatherErrorMsg || "天気情報の取得に失敗しました。";
          }
        }
      } catch (contextualError: any) {
        console.error('[ChatContextBuilder] Error fetching contextual info for first message:', contextualError.message);
        currentLocationString = "現在地の取得中に全体的なエラーが発生しました。";
        currentWeatherString = "天気情報の取得中に全体的なエラーが発生しました。";
      }
    } else {
      currentLocationString = "（現在地情報は最初のメッセージでのみ提供されます）";
      currentWeatherString = "（天気情報は最初のメッセージでのみ提供されます）";
    }

    const characterSettingPrompt = fitWithinBudget(
      this.settings.systemPrompt || "あなたは親切なアシスタントです。",
      budget.system_prompt
    );

    return {
      character_setting_prompt: characterSettingPrompt,
      retrieved_context_string: retrievedContextString,
      narrative_summary: narrativeSummary,
      current_time: currentTime,
      current_location_string: currentLocationString,
      current_weather_string: currentWeatherString,
      working_memory_messages: workingMemoryMessages,
    };
  }
}
