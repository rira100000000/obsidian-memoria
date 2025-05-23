// src/chatContextBuilder.ts
import { moment } from 'obsidian';
import { ContextRetriever, RetrievedContext } from './contextRetriever';
import { LocationFetcher } from './locationFetcher';
import { CurrentContextualInfo } from './types';
import { BaseMessage } from "@langchain/core/messages";
import { GeminiPluginSettings } from './settings'; // Settings をインポート

/**
 * LLMに渡すためのコンテキスト情報をまとめたインターフェース
 */
export interface LlmContextInput {
  character_setting_prompt: string;
  retrieved_context_string: string;
  current_time: string;
  current_location_string: string;
  current_weather_string: string;
  // input: string; // ユーザー入力は呼び出し側で別途渡すため、ここでは含めない
}

/**
 * ChatContextBuilderクラス
 * LLMに渡すコンテキスト情報（記憶、天気、時刻など）の収集と整形を担当します。
 */
export class ChatContextBuilder {
  private contextRetriever: ContextRetriever;
  private locationFetcher: LocationFetcher;
  private settings: GeminiPluginSettings; // 設定を保持

  constructor(
    contextRetriever: ContextRetriever,
    locationFetcher: LocationFetcher,
    settings: GeminiPluginSettings // 設定を受け取る
  ) {
    this.contextRetriever = contextRetriever;
    this.locationFetcher = locationFetcher;
    this.settings = settings; // 設定を保存
  }

  /**
   * 設定が変更された場合に呼び出され、内部の設定を更新します。
   * @param newSettings 新しいプラグイン設定。
   */
  public onSettingsChanged(newSettings: GeminiPluginSettings): void {
    this.settings = newSettings;
    // ContextRetriever や LocationFetcher も設定に依存している場合、
    // それらの onSettingsChanged も呼び出すか、ここで再初期化が必要になることがあります。
    // 今回は、ChatView 側で各モジュールの onSettingsChanged が呼ばれる想定なので、ここでは settings の更新のみ。
  }

  /**
   * LLMへの入力に必要なコンテキスト情報を収集・整形して返します。
   * @param userInput 現在のユーザー入力。
   * @param llmRoleName LLMのロール名。
   * @param chatHistory 現在のチャット履歴。
   * @param isFirstActualUserMessage これが最初の実際のユーザーメッセージかどうか。
   * @returns {Promise<LlmContextInput>} LLMの入力として使われるコンテキスト情報。
   */
  public async prepareContextForLlm(
    userInput: string,
    llmRoleName: string,
    chatHistory: BaseMessage[],
    isFirstActualUserMessage: boolean
  ): Promise<LlmContextInput> {
    let retrievedContextString = "記憶からの関連情報は見つかりませんでした。";
    try {
      const retrievedContextResult: RetrievedContext = await this.contextRetriever.retrieveContextForPrompt(
        userInput,
        llmRoleName,
        chatHistory
      );
      if (retrievedContextResult.llmContextPrompt && retrievedContextResult.llmContextPrompt.trim() !== "") {
        retrievedContextString = retrievedContextResult.llmContextPrompt;
      }
    } catch (contextError: any) {
      console.error('[ChatContextBuilder] Error retrieving context:', contextError.message, contextError.stack);
      // エラーが発生しても、デフォルトのretrievedContextStringで続行
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

    const characterSettingPrompt = this.settings.systemPrompt || "あなたは親切なアシスタントです。";

    return {
      character_setting_prompt: characterSettingPrompt,
      retrieved_context_string: retrievedContextString,
      current_time: currentTime,
      current_location_string: currentLocationString,
      current_weather_string: currentWeatherString,
    };
  }
}
