// src/contextRetriever.ts
import { App, TFile, parseYaml, Notice, moment } from 'obsidian';
import ObsidianMemoria from '../main';
import { GeminiPluginSettings } from './settings';
import { TagScores, TagProfilingNoteFrontmatter, SummaryNoteFrontmatter, RetrievedContextItem, RetrievedContext, LlmContextEvaluationResponse } from './types'; // types.ts からインポート
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

const TAG_SCORES_FILE = 'tag_scores.json';
const TPN_DIR = 'TagProfilingNote';
const SN_DIR = 'SummaryNote';
const FL_DIR = 'FullLog';

// Export interfaces used by other modules
export type { RetrievedContextItem, RetrievedContext, LlmContextEvaluationResponse };

export class ContextRetriever {
  private app: App;
  private plugin: ObsidianMemoria;
  private settings: GeminiPluginSettings;
  private keywordLlm: ChatGoogleGenerativeAI | null = null;
  private mainLlmForContextEval: ChatGoogleGenerativeAI | null = null;

  constructor(plugin: ObsidianMemoria) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.settings = plugin.settings;
    this.initializeLlms();
  }

  private initializeLlms() {
    if (!this.settings.geminiApiKey) {
      console.warn("[ContextRetriever] Gemini API key not set. LLMs not initialized.");
      this.keywordLlm = null;
      this.mainLlmForContextEval = null;
      return;
    }

    const keywordModelName = this.settings.keywordExtractionModel || this.settings.geminiModel;
    if (keywordModelName) {
      try {
        this.keywordLlm = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: keywordModelName,
        });
        console.log(`[ContextRetriever] Keyword LLM initialized with model: ${keywordModelName}`);
      } catch (e: any) {
        console.error("[ContextRetriever] Failed to initialize Keyword LLM:", e.message);
        this.keywordLlm = null;
        new Notice("キーワード抽出用LLMの初期化に失敗しました。");
      }
    } else {
        console.warn("[ContextRetriever] Keyword extraction model name not set. Keyword LLM not initialized.");
        this.keywordLlm = null;
    }

    if (this.settings.geminiModel) {
        try {
            this.mainLlmForContextEval = new ChatGoogleGenerativeAI({
                apiKey: this.settings.geminiApiKey,
                model: this.settings.geminiModel,
            });
            console.log(`[ContextRetriever] Main LLM for context evaluation initialized with model: ${this.settings.geminiModel}`);
        } catch (e: any) {
            console.error("[ContextRetriever] Failed to initialize Main LLM for context evaluation:", e.message);
            this.mainLlmForContextEval = null;
            new Notice("コンテキスト評価用LLMの初期化に失敗しました。");
        }
    } else {
        console.warn("[ContextRetriever] Main chat model name not set. Main LLM for context evaluation not initialized.");
        this.mainLlmForContextEval = null;
    }
  }

  public onSettingsChanged() {
    this.settings = this.plugin.settings;
    this.initializeLlms();
    console.log('[ContextRetriever] Settings changed, LLMs re-initialized.');
  }

  public async retrieveContextForPrompt(userPrompt: string, llmRoleName: string, chatHistory: BaseMessage[]): Promise<RetrievedContext> {
    const result: RetrievedContext = {
      originalPrompt: userPrompt,
      identifiedKeywords: [],
      retrievedItems: [],
      llmContextPrompt: "記憶からの関連情報は見つかりませんでした。",
    };

    if (!this.keywordLlm || !this.mainLlmForContextEval) {
        new Notice("記憶想起機能に必要なLLMが初期化されていません。");
        return result;
    }

    // 既存タグを考慮してキーワードを抽出・スコアリング
    const tagScores = await this.loadTagScores();
    const existingTags = Object.keys(tagScores);
    result.identifiedKeywords = await this.extractAndScoreKeywords(userPrompt, llmRoleName, existingTags);
    
    const currentContextItems: RetrievedContextItem[] = [];

    if (result.identifiedKeywords.length > 0) {
      const rankedTags = await this.getRankedTags(result.identifiedKeywords); // このメソッドはidentifiedKeywordsのスコアを元にTPN取得対象を選ぶ
      if (rankedTags.length > 0) {
        const maxTags = this.settings.maxTagsToRetrieve !== undefined ? this.settings.maxTagsToRetrieve : 5;
        const tpnItems = await this.fetchTpnItems(rankedTags.slice(0, maxTags));
        currentContextItems.push(...tpnItems);
      }
    }
    result.retrievedItems = [...currentContextItems];

    let evaluationCount = 0;
    const MAX_EVALUATIONS = 2;

    while (evaluationCount < MAX_EVALUATIONS) {
        if (currentContextItems.length === 0 && evaluationCount === 0) {
            console.log("[ContextRetriever] No TPN items found initially. Skipping LLM evaluation for TPNs.");
            break;
        }

        const currentContextForEval = this.formatContextForLlmEvaluation(currentContextItems, userPrompt, chatHistory);
        const evalPrompt = this.buildLlmContextEvaluationPrompt(currentContextForEval, userPrompt, llmRoleName, evaluationCount === 0 ? 'TPN' : 'SN');

        try {
            const llmResponse = await this.mainLlmForContextEval.invoke([new HumanMessage(evalPrompt)]);
            const responseContent = llmResponse.content as string;
            console.log(`[ContextRetriever] LLM Context Evaluation Response (Attempt ${evaluationCount + 1}):`, responseContent);
            result.llmEvaluationResponse = responseContent;

            let parsedEval: LlmContextEvaluationResponse | null = null;
            try {
                const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
                if (jsonMatch && jsonMatch[1]) {
                    parsedEval = JSON.parse(jsonMatch[1]) as LlmContextEvaluationResponse;
                } else {
                    console.warn("[ContextRetriever] LLM context evaluation response was not in expected JSON format. Trying to parse directly.");
                    parsedEval = JSON.parse(responseContent) as LlmContextEvaluationResponse;
                }
            } catch (parseError: any) {
                console.error("[ContextRetriever] Failed to parse LLM context evaluation JSON:", parseError.message, "\nRaw response:", responseContent);
                break;
            }

            if (parsedEval?.sufficient_for_response) {
                console.log("[ContextRetriever] LLM deemed current context sufficient.");
                break;
            }

            let newItemsFetched = false;
            if (evaluationCount === 0 && parsedEval?.next_summary_notes_to_fetch && parsedEval.next_summary_notes_to_fetch.length > 0) {
                console.log(`[ContextRetriever] LLM requested SNs: ${parsedEval.next_summary_notes_to_fetch.join(', ')}`);
                result.nextSnToFetch = parsedEval.next_summary_notes_to_fetch;
                const snItems = await this.fetchSnItems(result.nextSnToFetch);
                if (snItems.length > 0) {
                    currentContextItems.push(...snItems);
                    result.retrievedItems.push(...snItems);
                    newItemsFetched = true;
                }
            } else if (evaluationCount === 1 && parsedEval?.requires_full_log_for_summary_note) {
                console.log(`[ContextRetriever] LLM requested FL for SN: ${parsedEval.requires_full_log_for_summary_note}`);
                result.nextFlToFetch = parsedEval.requires_full_log_for_summary_note;
                const flItem = await this.fetchFlItem(result.nextFlToFetch);
                if (flItem) {
                    currentContextItems.push(flItem);
                    result.retrievedItems.push(flItem);
                    newItemsFetched = true;
                }
            }

            if (!newItemsFetched && !parsedEval?.sufficient_for_response) {
                console.log("[ContextRetriever] No new items fetched, but LLM still deems context insufficient. Breaking evaluation loop.");
                break;
            }
        } catch (e: any) {
            console.error(`[ContextRetriever] Error during LLM context evaluation (Attempt ${evaluationCount + 1}):`, e.message);
            break;
        }
        evaluationCount++;
    }

    if (result.retrievedItems.length > 0) {
      result.llmContextPrompt = this.formatContextForFinalLlm(result.retrievedItems, userPrompt);
    }
    return result;
  }

  private async extractAndScoreKeywords(userPrompt: string, llmRoleName: string, existingTags: string[]): Promise<Array<{ keyword: string; inPromptScore: number }>> {
    if (!this.keywordLlm) {
        console.warn("[ContextRetriever] Keyword LLM not available for extractAndScoreKeywords.");
        return [];
    }

    // プロンプトテンプレートを修正して既存タグリストを渡す
    const promptTemplate = this.settings.prompts?.keywordExtractionPrompt ||
                   `ユーザーの現在のメッセージは「{userPrompt}」です。このメッセージはLLMキャラクター「{llmRoleName}」に向けられています。
既存の知識ベースには以下のタグが存在します:
{existingTagsString}

タスク:
1. ユーザーメッセージと最も関連性の高い既存タグを上記リストから最大3つまで選択してください。
2. もし既存タグだけでは不十分な場合、またはユーザーメッセージ中の重要な概念が既存タグでカバーされていない場合、新しいキーワードを最大2つまで追加で抽出してください。新しいキーワードは既存タグと重複しないようにしてください。
3. 選択・抽出した各タグ/キーワードに対して、今回のユーザーメッセージ内での相対的な重要度を0から100の範囲でスコアリングしてください。

応答は以下のJSON形式の配列で、タグ/キーワード(keyword)とそのスコア(score)を含めてください。
例:
[
  { "keyword": "既存タグA", "score": 90 },
  { "keyword": "新しいキーワードX", "score": 75 },
  { "keyword": "既存タグB", "score": 80 }
]

もし適切なタグ/キーワードが見つからない場合は、空の配列 [] を返してください。
JSONオブジェクトのみを返し、他のテキストは含めないでください。`;
    
    const existingTagsString = existingTags.length > 0 ? existingTags.join(', ') : 'なし';
    const filledPrompt = promptTemplate
        .replace('{userPrompt}', userPrompt)
        .replace('{llmRoleName}', llmRoleName)
        .replace('{existingTagsString}', existingTagsString);

    try {
      const llmResponse = await this.keywordLlm.invoke([new HumanMessage(filledPrompt)]);
      const responseContent = llmResponse.content as string;
      console.log("[ContextRetriever] Keyword Extraction Raw Response (with existing tags):", responseContent);

      let keywordsWithScores: Array<{ keyword: string; score: number }> = [];
      const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        keywordsWithScores = JSON.parse(jsonMatch[1]);
      } else {
        try {
            keywordsWithScores = JSON.parse(responseContent);
        } catch (directParseError) {
            console.warn("[ContextRetriever] Failed to parse keyword extraction response directly. Assuming no keywords found. Error:", directParseError);
            return [];
        }
      }
      return keywordsWithScores.map(item => ({ keyword: item.keyword, inPromptScore: item.score }));
    } catch (e: any) {
      console.error("[ContextRetriever] Error in extractAndScoreKeywords LLM call or parsing (with existing tags):", e.message);
      new Notice("キーワードの抽出とスコアリング中にエラーが発生しました。");
      return [];
    }
  }

  private async getRankedTags(scoredKeywords: Array<{ keyword: string; inPromptScore: number }>): Promise<Array<{ tagName: string; score: number; originalKeyword: string }>> {
    const tagScoresData = await this.loadTagScores();
    const rankedTags: Array<{ tagName: string; score: number; originalKeyword: string }> = [];
    
    // scoredKeywords には、既存タグと新規キーワードが混在している可能性がある
    // TPNを取得するのは既存タグに対応するものだけ
    for (const kw of scoredKeywords) {
      // kw.keyword が既存タグかどうかを判定
      if (tagScoresData[kw.keyword]) {
        const tagInfo = tagScoresData[kw.keyword];
        const baseImportance = tagInfo.base_importance || 0;
        // スコアリングロジックは元のままでも良いし、調整しても良い
        // ここでは、LLMが既存タグを直接スコアリングした結果(kw.inPromptScore)を重視する形も考えられる
        // 例: const finalScore = kw.inPromptScore; 
        const finalScore = (kw.inPromptScore * 0.7) + (baseImportance * 0.3); // 元のロジック
        rankedTags.push({ tagName: kw.keyword, score: finalScore, originalKeyword: kw.keyword });
      } else {
        // 新規キーワードの場合、TPNは存在しないのでここでは何もしない
        // identifiedKeywordsには残るので、将来的に新規タグとしてTPN作成するフローに繋げられる
        console.log(`[ContextRetriever] Keyword "${kw.keyword}" is new or not in tag_scores.json, skipping TPN fetch for it.`);
      }
    }
    return rankedTags.sort((a, b) => b.score - a.score);
  }

  private async fetchTpnItems(rankedTags: Array<{ tagName: string; score: number; originalKeyword: string }>): Promise<RetrievedContextItem[]> {
    const items: RetrievedContextItem[] = [];
    for (const tagInfo of rankedTags) {
      const tpnSafeTagName = tagInfo.tagName.replace(/[\\/:*?"<>|#^[\]]/g, '_');
      const tpnPath = `${TPN_DIR}/TPN-${tpnSafeTagName}.md`;
      const fileContent = await this.getFileContent(tpnPath);
      if (fileContent) {
        const frontmatter = this.parseFrontmatter(fileContent) as TagProfilingNoteFrontmatter | null;
        if (frontmatter) {
          let snippet = "";
          // フロントマター情報をスニペットに追加
          if (frontmatter.master_significance) snippet += `このタグ「${tagInfo.tagName}」の全体的な重要性: ${frontmatter.master_significance}\n`;
          if (frontmatter.key_themes && frontmatter.key_themes.length > 0) snippet += `関連キーテーマ: ${frontmatter.key_themes.join(', ')}\n`;
          if (frontmatter.user_sentiment?.overall) snippet += `ユーザーの総合的な感情: ${frontmatter.user_sentiment.overall}\n`;
          if (frontmatter.aliases && frontmatter.aliases.length > 0) snippet += `別名・関連語: ${frontmatter.aliases.join(', ')}\n`;


          // 本文の主要セクションを抽出してスニペットに追加
          // ## 概要 (Overview)
          const overviewMatch = fileContent.match(/## 概要\s*([\s\S]*?)(?=\n## |$)/);
          if (overviewMatch && overviewMatch[1] && overviewMatch[1].trim()) {
            snippet += `\n## 概要\n${overviewMatch[1].trim()}\n`;
          }

          // ## これまでの主な文脈 (Key Contexts)
          const contextsMatch = fileContent.match(/## これまでの主な文脈\s*([\s\S]*?)(?=\n## |$)/);
          if (contextsMatch && contextsMatch[1] && contextsMatch[1].trim()) {
            snippet += `\n## これまでの主な文脈\n${contextsMatch[1].trim()}\n`;
          }

          // ## ユーザーの意見・反応 (User Opinions/Reactions)
          const opinionsMatch = fileContent.match(/## ユーザーの意見・反応\s*([\s\S]*?)(?=\n## |$)/);
          if (opinionsMatch && opinionsMatch[1] && opinionsMatch[1].trim()) {
            snippet += `\n## ユーザーの意見・反応\n${opinionsMatch[1].trim()}\n`;
          }
          
          // ## その他メモ (Other Notes) - オプションとして追加
          const otherNotesMatch = fileContent.match(/## その他メモ\s*([\s\S]*?)(?=\n## |$)/);
          if (otherNotesMatch && otherNotesMatch[1] && otherNotesMatch[1].trim()) {
            snippet += `\n## その他メモ\n${otherNotesMatch[1].trim()}\n`;
          }

          // contentSnippetの長さを制限 (例: 1500文字)
          // この値は設定可能にしても良いし、トークナイザベースの制限も検討可能
          const maxSnippetLength = this.settings.maxContextLength / (this.settings.maxTagsToRetrieve || 5) - 200; // 簡易的な分配、要調整
          if (snippet.length > maxSnippetLength) {
              snippet = snippet.substring(0, maxSnippetLength) + "... (TPN内容一部省略)";
          }

          items.push({
            sourceType: 'TPN',
            sourceName: `TPN-${tpnSafeTagName}`,
            title: `タグプロファイル: ${tagInfo.tagName}`,
            date: frontmatter.updated_date || frontmatter.created_date,
            contentSnippet: snippet.trim() || "関連情報なし", // snippetが空の場合のフォールバック
            relevance: tagInfo.score,
          });
        }
      }
    }
    return items;
  }


  private async fetchSnItems(snFileNames: string[]): Promise<RetrievedContextItem[]> {
    const items: RetrievedContextItem[] = [];
    const uniqueSnFileNames = [...new Set(snFileNames.map(name => this.cleanFileName(name)))];
    for (const snFileName of uniqueSnFileNames) {
      const snPath = `${SN_DIR}/${snFileName}.md`;
      const fileContent = await this.getFileContent(snPath);
      if (fileContent) {
        const frontmatter = this.parseFrontmatter(fileContent) as SummaryNoteFrontmatter | null;
        if (frontmatter) {
          let snippet = "";
          const summaryMatch = fileContent.match(/## 要約\s*([\s\S]*?)(?=\n## |$)/);
          if (summaryMatch && summaryMatch[1]) {
            snippet += `${summaryMatch[1].trim().substring(0, 500)}...\n`;
          } else {
            const bodyContentMatch = fileContent.match(/---[\s\S]+?---([\s\S]*)/);
            if (bodyContentMatch && bodyContentMatch[1]) {
                snippet += `${bodyContentMatch[1].trim().split('\n\n')[0].substring(0,500)}...\n`;
            }
          }
          if (frontmatter.key_takeaways && frontmatter.key_takeaways.length > 0) {
            snippet += `主なポイント: ${frontmatter.key_takeaways.join('; ')}\n`;
          }
          items.push({
            sourceType: 'SN',
            sourceName: snFileName,
            title: frontmatter.title,
            date: frontmatter.date ? moment(frontmatter.date, "YYYY-MM-DD HH:mm:ss").format("YYYY-MM-DD HH:MM") : undefined,
            contentSnippet: snippet.trim() || "関連情報なし",
          });
        }
      }
    }
    return items;
  }

  private async fetchFlItem(snFileNameWithExtOrWithout: string): Promise<RetrievedContextItem | null> {
    const cleanSnFileName = this.cleanFileName(snFileNameWithExtOrWithout);
    const snPath = `${SN_DIR}/${cleanSnFileName}.md`;
    const snContent = await this.getFileContent(snPath);
    if (!snContent) return null;

    const snFrontmatter = this.parseFrontmatter(snContent) as SummaryNoteFrontmatter | null;
    if (!snFrontmatter || !snFrontmatter.full_log) return null;

    const flFileName = this.cleanFileName(snFrontmatter.full_log);
    const flPath = `${FL_DIR}/${flFileName}.md`;
    const flContent = await this.getFileContent(flPath);

    if (flContent) {
      const bodyMatch = flContent.match(/---[\s\S]+?---([\s\S]*)/);
      const logExcerpt = bodyMatch && bodyMatch[1] ? bodyMatch[1].trim().substring(0, 800) : "ログ抜粋利用不可";
      return {
        sourceType: 'FullLog',
        sourceName: flFileName,
        title: `会話ログ: ${snFrontmatter.title || flFileName}`,
        date: snFrontmatter.date ? moment(snFrontmatter.date, "YYYY-MM-DD HH:mm:ss").format("YYYY-MM-DD HH:MM") : undefined,
        contentSnippet: `会話ログ抜粋:\n${logExcerpt}...\n`,
      };
    }
    return null;
  }

  private buildLlmContextEvaluationPrompt(currentContextForEval: string, userPrompt: string, llmRoleName: string, currentLevel: 'TPN' | 'SN'): string {
    const promptTemplate = this.settings.prompts?.contextEvaluationPromptBase ||
        `あなたはユーザー「{llmRoleName}」の記憶と思考を補助するAIです。
ユーザーの現在の質問は「{userPrompt}」です。
現在までに以下の参考情報が集まっています。
---
{currentContextForEval}
---
あなたのタスクは、これらの情報がユーザーの現在の質問に適切に応答するために十分かどうかを評価することです。
応答は必ず以下のJSON形式で出力してください。
\`\`\`json
{
  "sufficient_for_response": <true または false>,
  "reasoning": "<判断理由を簡潔に記述>",
  "next_summary_notes_to_fetch": ["<もし 'sufficient_for_response' が false で、次に参照すべきサマリーノートがあれば、そのファイル名を複数指定 (例: 'SN-YYYYMMDDHHMM-Topic1', 'SN-YYYYMMDDHHMM-Topic2')。不要なら空配列 []>"],
  "requires_full_log_for_summary_note": "<もし 'sufficient_for_response' が false で、特定のサマリーノートのフルログが必要な場合、そのサマリーノートのファイル名を指定 (例: 'SN-YYYYMMDDHHMM-TopicX')。不要なら null>"
}
\`\`\`
考慮事項:
- 現在の評価レベルは「{currentLevel}」です。
- {currentLevelSpecificConsideration}
- ユーザーの質問の意図を深く理解し、本当に必要な情報だけを要求するようにしてください。
- \`next_summary_notes_to_fetch\` と \`requires_full_log_for_summary_note\` は、\`sufficient_for_response\` が false の場合にのみ意味を持ちます。
- \`requires_full_log_for_summary_note\` は、既にSNを読み込んだ後、そのSNに紐づくFLが必要な場合に指定します。
JSONオブジェクトのみを返し、他のテキストは含めないでください。`;

    let levelSpecificConsideration = "";
    if (currentLevel === 'TPN') {
        levelSpecificConsideration = "TPNの情報だけでは具体的な会話内容が不足していることが多いです。関連性の高いSNがあれば積極的に参照を指示してください。";
    } else if (currentLevel === 'SN') {
        levelSpecificConsideration = "SNの情報で大筋が掴めるが、詳細なニュアンスや特定のやり取りの確認が必要な場合にFLの参照を検討してください。";
    }

    return promptTemplate
        .replace('{llmRoleName}', llmRoleName)
        .replace('{userPrompt}', userPrompt)
        .replace('{currentContextForEval}', currentContextForEval)
        .replace('{currentLevel}', currentLevel)
        .replace('{currentLevelSpecificConsideration}', levelSpecificConsideration);
  }

  private formatContextForLlmEvaluation(items: RetrievedContextItem[], userPrompt: string, chatHistory: BaseMessage[]): string {
    if (items.length === 0 && chatHistory.length === 0) return "現在参照可能な記憶情報も会話履歴もありません。";
    
    let contextString = "直近の会話履歴:\n";
    const recentHistory = chatHistory.slice(-4); // 履歴の数を調整可能
    if (recentHistory.length === 0) {
        contextString += "なし\n";
    } else {
        recentHistory.forEach(msg => {
            const role = msg._getType() === "human" ? "User" : "Assistant"; // Langchainの型に応じて調整
            contextString += `${role}: ${msg.content}\n`;
        });
    }
    
    contextString += "\n現在のユーザーの質問: " + userPrompt + "\n\n";

    if (items.length === 0) {
        contextString += "収集済みの参考情報: なし\n";
    } else {
        contextString += "収集済みの参考情報:\n";
        // 関連度スコアでソート（もしあれば）
        const sortedItems = [...items].sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
        for (const item of sortedItems) {
          contextString += `\n[参照元: ${item.sourceType} - ${item.sourceName} (${item.date || '日付不明'})]\n`;
          if (item.title) contextString += `タイトル: ${item.title}\n`;
          // contentSnippetの長さをここでも制限する（例：500文字）
          const snippetForEval = item.contentSnippet.length > 500 ? `${item.contentSnippet.substring(0, 500)}...` : item.contentSnippet;
          contextString += `内容抜粋:\n${snippetForEval}\n---\n`;
        }
    }
    const maxLength = this.settings.maxContextLengthForEvaluation !== undefined ? this.settings.maxContextLengthForEvaluation : 3500;
    return contextString.substring(0, maxLength);
  }

  private formatContextForFinalLlm(items: RetrievedContextItem[], userPrompt: string): string {
    if (items.length === 0) return "記憶からの関連情報は見つかりませんでした。";
    
    let contextString = "";
    // 関連度スコアでソート（もしあれば）
    const sortedItems = [...items].sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
    
    for (const item of sortedItems) {
      contextString += `\n[参照元: ${item.sourceType} - ${item.sourceName} (${item.date || '日付不明'})]\n`;
      if (item.title) contextString += `タイトル: ${item.title}\n`;
      // fetchTpnItemsで既にスニペット長が調整されていることを期待するが、念のためここでも最終調整
      // ここでの700文字制限は、複数の情報を組み合わせることを想定している
      const snippet = item.contentSnippet.length > 700 ? `${item.contentSnippet.substring(0, 700)}... (詳細省略)` : item.contentSnippet;
      contextString += `内容抜粋:\n${snippet}\n---\n`;
    }
    
    const maxLength = this.settings.maxContextLength !== undefined ? this.settings.maxContextLength : 3500;
    if (contextString.length > maxLength) {
        contextString = contextString.substring(0, maxLength) + "... (記憶情報全体を一部省略)...";
    }
    return contextString;
  }


  private async loadTagScores(): Promise<TagScores> {
    try {
      const fileExists = await this.app.vault.adapter.exists(TAG_SCORES_FILE);
      if (fileExists) {
        const content = await this.app.vault.adapter.read(TAG_SCORES_FILE);
        return JSON.parse(content) as TagScores;
      }
    } catch (error: any) {
      console.error(`[ContextRetriever] Error reading ${TAG_SCORES_FILE}, creating a new one. Error:`, error.message);
    }
    return {};
  }

  private async getFileContent(filePath: string): Promise<string | null> {
    try {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        return await this.app.vault.cachedRead(file);
      }
      console.warn(`[ContextRetriever] File not found or not a TFile: ${filePath}`);
      return null;
    } catch (error: any) {
      console.error(`[ContextRetriever] Error reading file ${filePath}:`, error.message);
      return null;
    }
  }

  private parseFrontmatter(content: string): Record<string, any> | null {
    try {
      const frontmatterMatch = content.match(/^---([\s\S]+?)---/);
      if (frontmatterMatch && frontmatterMatch[1]) {
        return parseYaml(frontmatterMatch[1]);
      }
      return null;
    } catch (e: any) {
      console.error('[ContextRetriever] Error parsing YAML frontmatter:', e.message);
      return null;
    }
  }

  private cleanFileName(fileName: string): string {
    // [[ファイル名]] や ファイル名.md のような形式を ファイル名 に統一
    return fileName.replace(/\[\[|\]\]/g, '').replace(/\.md$/, '');
  }
}
