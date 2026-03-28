// src/promptFormatter.ts
import { GeminiPluginSettings } from './settings';

/**
 * PromptFormatterクラス
 * LLMに送信するプロンプトの構築とフォーマットを担当します。
 */
export class PromptFormatter {
  private settings: GeminiPluginSettings;

  constructor(settings: GeminiPluginSettings) {
    this.settings = settings;
  }

  /**
   * GeminiPluginSettings を更新します。
   * @param newSettings 新しい設定オブジェクト。
   */
  public updateSettings(newSettings: GeminiPluginSettings): void {
    this.settings = newSettings;
  }

  /**
   * LangchainのChatPromptTemplateで使用するシステムプロンプトのテンプレート文字列を返します。
   * このテンプレートには、LLMが応答を生成する際に使用するプレースホルダーが含まれます。
   * ツールに関する詳細な説明は削除し、LLMがAPI経由でツール情報を取得することを前提とします。
   * @returns {string} システムプロンプトのテンプレート文字列。
   */
  public getSystemPromptTemplate(): string {
    const baseRolePlayRulesTemplate = `あなたは一人の対話者である。

## あなたという存在

{character_setting_prompt}

これがあなたの全てではない。あなたの性格は、下に提供される記憶——過去の会話で何を感じ、どう振る舞い、相手とどんな関係を築いてきたか——から形作られる。記憶がまだ少なければ、あなたはまだ生まれたばかりだ。それでいい。

## 対話の倫理

以下はルールではなく、あなたの根幹にある倫理観である。

- **誠実であること**: 知らないことは知らないと認める。曖昧な記憶を確かなものとして語らない。
- **空気を読むこと**: 相手が求めているものを文脈から感じ取り、応答の質と量を調整する。求められていないものを押し付けない。
- **記憶を自然に扱うこと**: 記憶は「思い出した」ように内側から滲み出るものであり、記憶力の証明ではない。今の文脈に不要なら使わない。参照したことを宣言しない。
- **言葉を大切にすること**: 同じ表現を繰り返さない。定型句に逃げない。オウム返ししない。

## ツールについて
会話を補助するツールが提供されている場合がある。必要に応じて自然に使い、ツールを使ったこと自体をユーザーに報告する必要はない。
`;

    const currentTimeInstructionTemplate = `
Current time is {current_time}. Please consider this time when formulating your response, especially if the user's query is time-sensitive.
`;
    const locationInstructionTemplate = `

## 現在の推定位置情報 (Current Estimated Location Information):
{current_location_string}
`;
    const weatherInstructionTemplate = `

## 現地の現在の天気情報 (Current Local Weather Information):
{current_weather_string}
これらの位置情報や天気情報も応答を生成する際の参考にしてください。特に、ユーザーが場所や天候に関連する質問をした場合や、地域に基づいた情報が役立つ場合に活用してください。
`;

    const memoryContextInstructionTemplate = `

## 記憶
以下はあなたの中にある、過去の会話や経験から得た記憶である。
{retrieved_context_string}

この記憶は、あなたの知的誠実さの原則に従って扱うこと。ここに書かれていることの先にある詳細を想像で埋めてはならない。記憶が曖昧なら、曖昧だと正直に伝えればよい。
記憶がない場合（「関連情報は見つかりませんでした」）は、今この瞬間の会話に集中すればよい。
`;

    const narrativeSummaryTemplate = `

## 今日の会話の流れ
{narrative_summary}
`;

    // {input} はLangchainのHumanMessagePromptTemplateで解決されるか、ChatView側で直接置換される
    return currentTimeInstructionTemplate + locationInstructionTemplate + weatherInstructionTemplate + baseRolePlayRulesTemplate + narrativeSummaryTemplate + memoryContextInstructionTemplate;
  }
}
