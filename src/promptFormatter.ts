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
   * LLMに送信する最終的なシステムプロンプト文字列を構築します。
   * これには、ロールプレイルール、キャラクター設定、および動的なコンテキスト情報が含まれます。
   * @param characterSettingPrompt - ユーザーが設定したキャラクター設定プロンプト。
   * @param currentTime - 現在時刻の文字列。
   * @param currentLocationString - 現在の位置情報の文字列。
   * @param currentWeatherString - 現在の天気情報の文字列。
   * @param retrievedContextString - 記憶から検索されたコンテキスト情報の文字列。
   * @returns {string} 構築された完全なシステムプロンプト。
   */
  public buildFinalSystemPrompt(
    characterSettingPrompt: string,
    currentTime: string,
    currentLocationString: string,
    currentWeatherString: string,
    retrievedContextString: string
  ): string {
    // 固定のベースプロンプト（LLMキャラクターロールプレイルール）
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
    // テンプレート内のプレースホルダーを実際の情報で置き換える
    // (実際にはLangchainのPromptTemplateがこれを行うが、ここでは最終的な文字列を組み立てる例として示す)
    // このメソッドは、LangchainのChatPromptTemplateに渡す前の、
    // システムメッセージ全体のテンプレート文字列を生成する役割を担う。
    // そのため、{input}のようなLangchain側で解決されるプレースホルダーはそのまま残す。
    let populatedPrompt = currentTimeInstruction
        .replace('{current_time}', currentTime); // Langchain側で解決しないものはここで置換

    populatedPrompt += locationInstruction
        .replace('{current_location_string}', currentLocationString);

    populatedPrompt += weatherInstruction
        .replace('{current_weather_string}', currentWeatherString);

    populatedPrompt += baseRolePlayRules; // キャラクター設定は既に baseRolePlayRules に組み込まれている

    populatedPrompt += memoryContextInstruction
        .replace('{retrieved_context_string}', retrievedContextString);
        // {input} はLangchainのHumanMessagePromptTemplateで解決されるので、ここではそのまま

    return populatedPrompt;
  }

  /**
   * LangchainのChatPromptTemplateで使用するシステムプロンプトのテンプレート文字列を返します。
   * このテンプレートには、LLMが応答を生成する際に使用するプレースホルダーが含まれます。
   * @returns {string} システムプロンプトのテンプレート文字列。
   */
  public getSystemPromptTemplate(): string {
        // 固定のベースプロンプト（LLMキャラクターロールプレイルール）
        // {character_setting_prompt} は initializeChatModel で実際のキャラクター設定に置き換えられる
    const baseRolePlayRulesTemplate = `LLMキャラクターロールプレイ ルール
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
{character_setting_prompt} 
---
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
    // {input} はLangchainのHumanMessagePromptTemplateで解決されるため、システムプロンプトテンプレート内にも含めておく
    return currentTimeInstructionTemplate + locationInstructionTemplate + weatherInstructionTemplate + baseRolePlayRulesTemplate + memoryContextInstructionTemplate;
  }
}
