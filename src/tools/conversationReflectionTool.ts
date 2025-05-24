// src/tools/conversationReflectionTool.ts
import { Tool } from "@langchain/core/tools";
import { App, TFile, moment, Notice, normalizePath, stringifyYaml } from 'obsidian';
import { BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import ObsidianMemoria from "../../main";
import { GeminiPluginSettings, DEFAULT_SETTINGS } from "../settings";
import { TagScores, SummaryNoteFrontmatter } from "../types";
import { TagProfiler } from '../tagProfiler';

const TAG_SCORES_FILE = 'tag_scores.json';
const SUMMARY_NOTE_DIR = 'SummaryNote';

export interface ConversationReflectionToolInput {
    conversationHistory: BaseMessage[];
    llmRoleName: string;
    fullLogFileName: string;
}

interface ReflectionLLMResponse {
    conversationTitle: string;
    tags: string[]; // This might be initially empty if tags are extracted from reflectionBody later
    mood: string;
    keyTakeaways: string[];
    actionItems: string[];
    reflectionBody: string;
}


export class ConversationReflectionTool extends Tool {
    static lc_name() {
        return "ConversationReflectionTool";
    }

    name = "conversation_reflection_and_summary_tool";
    description = "LLMが現在の会話について自身の視点から振り返りを行い、その内容をサマリーノート形式で新しいMarkdownファイルに書き出すことを可能にします。入力は 'conversationHistory', 'llmRoleName', 'fullLogFileName' を含むオブジェクトであるべきです。";

    private app: App;
    private plugin: ObsidianMemoria;
    private settings: GeminiPluginSettings;
    private llm: ChatGoogleGenerativeAI | null = null;
    private keywordLlm: ChatGoogleGenerativeAI | null = null;
    private tagProfiler: TagProfiler;

    constructor(plugin: ObsidianMemoria, llm?: ChatGoogleGenerativeAI) {
        super();
        this.plugin = plugin;
        this.app = plugin.app;
        this.settings = plugin.settings;
        this.llm = llm || this.initializeLlm();
        this.keywordLlm = this.initializeKeywordLlm();
        this.tagProfiler = new TagProfiler(this.plugin);
    }

    private initializeLlm(): ChatGoogleGenerativeAI | null {
        if (this.settings.geminiApiKey && this.settings.geminiModel) {
            try {
                return new ChatGoogleGenerativeAI({
                    apiKey: this.settings.geminiApiKey,
                    model: this.settings.geminiModel,
                });
            } catch (e: any) {
                console.error("[ConversationReflectionTool] メインLLMの初期化に失敗しました:", e.message);
                return null;
            }
        }
        console.warn("[ConversationReflectionTool] Gemini APIキーまたはモデルが設定されていないため、メインLLMを初期化できません。");
        return null;
    }

    private initializeKeywordLlm(): ChatGoogleGenerativeAI | null {
        const keywordModelName = this.settings.keywordExtractionModel || this.settings.geminiModel;
        if (this.settings.geminiApiKey && keywordModelName) {
            try {
                return new ChatGoogleGenerativeAI({
                    apiKey: this.settings.geminiApiKey,
                    model: keywordModelName,
                });
            } catch (e: any) {
                console.error("[ConversationReflectionTool] キーワード抽出用LLMの初期化に失敗しました:", e.message);
                return null;
            }
        }
        console.warn("[ConversationReflectionTool] Gemini APIキーまたはキーワード抽出用モデルが設定されていないため、キーワード抽出用LLMを初期化できません。");
        return null;
    }

    public onSettingsChanged(): void {
        this.settings = this.plugin.settings;
        this.llm = this.initializeLlm();
        this.keywordLlm = this.initializeKeywordLlm();
        if (this.tagProfiler && typeof (this.tagProfiler as any).onSettingsChanged === 'function') {
            (this.tagProfiler as any).onSettingsChanged();
        }
        console.log('[ConversationReflectionTool] 設定が変更され、LLMおよびTagProfilerが再初期化/更新されました。');
    }

    private formatConversationHistory(history: BaseMessage[], llmRoleNameToUse: string): string {
        return history
            .map(msg => {
                const type = msg._getType();
                const speaker = type === "human" ? "User" : (type === "ai" ? llmRoleNameToUse : "System");
                return `${speaker}: ${msg.content}`;
            })
            .join("\n\n");
    }

    private async loadTagScores(): Promise<TagScores> {
        try {
            const fileExists = await this.app.vault.adapter.exists(TAG_SCORES_FILE);
            if (fileExists) {
                const content = await this.app.vault.adapter.read(TAG_SCORES_FILE);
                return JSON.parse(content) as TagScores;
            }
        } catch (error) {
            console.error(`[ConversationReflectionTool] ${TAG_SCORES_FILE} の読み込みエラー:`, error);
        }
        return {};
    }

    private async extractTagsFromReflectionBody(reflectionBody: string, existingTags: string[], llmRoleName: string): Promise<string[]> {
        if (!this.keywordLlm) {
            console.warn("[ConversationReflectionTool] キーワード抽出用LLMが利用できないため、タグ抽出をスキップします。");
            return [];
        }
        const keywordExtractionPrompt = `
あなたはテキスト分析アシスタントです。
以下の「振り返りノートの本文」を読み、その内容を最もよく表すキーワードを5つ以内で抽出してください。
抽出するキーワードは、Obsidianのタグとして使用できる形式（例: 単一の単語、ハイフンやアンダースコアで繋いだ複合語、スペースなし）にしてください。
また、以下の「既存のタグリスト」も参考にし、もし振り返りノートの本文と合致する既存タグがあれば、それを優先的に使用してください。
新しいキーワードを提案する場合は、既存のタグリストと重複しないようにしてください。

振り返りノートの本文:
---
${reflectionBody}
---

既存のタグリスト (参考にしてください):
${existingTags.length > 0 ? existingTags.join(', ') : 'なし'}

抽出したキーワードをJSON配列の形式で返してください。例: ["キーワード1", "関連トピック", "新しい発見"]
JSON配列のみを返し、他のテキストは含めないでください。
`;
        console.log("[ConversationReflectionTool DEBUG] Keyword Extraction Prompt for Reflection Body:", keywordExtractionPrompt); // ★デバッグログ追加
        try {
            const response = await this.keywordLlm.invoke(keywordExtractionPrompt);
            const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
            console.log("[ConversationReflectionTool DEBUG] Tag Extraction LLM response (raw):", responseContent); // ★デバッグログ追加

            let extractedKeywords: string[] = [];
            const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                try { // ★追加: パースエラーをキャッチ
                    extractedKeywords = JSON.parse(jsonMatch[1]);
                } catch(e: any) {
                    console.error("[ConversationReflectionTool DEBUG] Failed to parse JSON from ```json block in tag extraction response:", e, "Content was:", jsonMatch[1]);
                    return [];
                }
            } else {
                 try {
                    extractedKeywords = JSON.parse(responseContent);
                } catch (e: any) { // ★変更: エラーオブジェクトと内容を出力
                    console.warn("[ConversationReflectionTool DEBUG] Tag Extraction LLM response was not a direct JSON array. Error:", e, "Raw content:", responseContent);
                    return [];
                }
            }
            console.log("[ConversationReflectionTool DEBUG] Parsed extracted keywords:", extractedKeywords); // ★デバッグログ追加

            if (Array.isArray(extractedKeywords)) {
                return extractedKeywords.map(tag =>
                    tag.trim()
                       .replace(/\s+/g, '-')
                       .replace(/[#,[\]{}|:"<>\/\\?*^()']/g, '') // タグに使えない記号を除去
                       .substring(0, 50) // 長すぎるタグを切り詰める
                ).filter(tag => tag.length > 0); // 空になったタグを除外
            }
            console.warn("[ConversationReflectionTool DEBUG] Extracted keywords is not an array:", extractedKeywords); // ★デバッグログ追加
            return [];
        } catch (error) {
            console.error("[ConversationReflectionTool DEBUG] Error during tag extraction from reflection body:", error); // ★デバッグログ追加
            return [];
        }
    }

    private sanitizeTitleForFilename(title: string): string {
        return title.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, '_').substring(0, 50);
    }

    protected async _call(input: string | ConversationReflectionToolInput): Promise<string | TFile> {
        console.log('[ConversationReflectionTool DEBUG] _call invoked with input:', JSON.stringify(input)); // ★変更: JSON.stringifyでオブジェクト内容も表示

        if (!this.llm) {
            const errorMsg = "エラー: メインLLMが初期化されていません。APIキーとモデル設定を確認してください。";
            console.error(`[ConversationReflectionTool] ${errorMsg}`);
            return errorMsg;
        }

        let conversationHistory: BaseMessage[];
        let llmRoleNameToUse: string;
        let fullLogFileName: string;

        if (typeof input === 'string') {
            console.error("[ConversationReflectionTool DEBUG] String input received, which is not expected for this tool's complexity.");
            return "エラー: このツールはオブジェクト形式の入力を期待します (conversationHistory, llmRoleName, fullLogFileName)。";
        } else {
            conversationHistory = input.conversationHistory;
            llmRoleNameToUse = input.llmRoleName;
            fullLogFileName = input.fullLogFileName;
            if (!llmRoleNameToUse || !llmRoleNameToUse.trim()){
                console.warn("[ConversationReflectionTool DEBUG] llmRoleName is empty or undefined in input. Falling back to settings or default.");
                llmRoleNameToUse = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;
            }
            if (!fullLogFileName || !fullLogFileName.trim()) {
                console.error("[ConversationReflectionTool DEBUG] fullLogFileName is missing in input.");
                return "エラー: fullLogFileName が提供されていません。";
            }
        }
        console.log(`[ConversationReflectionTool DEBUG] Using llmRoleName: ${llmRoleNameToUse}, fullLogFileName: ${fullLogFileName}`); // ★追加

        if (!conversationHistory || conversationHistory.length === 0) {
            console.warn("[ConversationReflectionTool DEBUG] No conversation history provided.");
            return "振り返りを生成するための会話履歴が提供されていません。";
        }

        const formattedHistory = this.formatConversationHistory(conversationHistory, llmRoleNameToUse);
        const characterSettings = this.settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt;

        const reflectionPrompt = `
あなたは、以下のキャラクター設定を持つ ${llmRoleNameToUse} です。
このキャラクター設定を完全に理解し、そのペルソナとして振る舞ってください。

あなたのキャラクター設定:
---
${characterSettings}
---

たった今、ユーザーとの以下の会話を終えました。この会話全体を、上記のキャラクター設定と ${llmRoleNameToUse} というあなたの役割に基づいて振り返り、以下の指示に従って情報を整理してください。
この情報は、Obsidianの「サマリーノート」として保存されます。

会話履歴:
---
${formattedHistory}
---

あなたのタスク:
以下のJSONオブジェクトの各フィールドを、あなたのキャラクターの視点から、会話内容に基づいて具体的に記述してください。
"reflectionBody" フィールドには、指定されたMarkdownフォーマットで振り返りを記述してください。

\`\`\`json
{
  "conversationTitle": "この会話にふさわしい簡潔で分かりやすいタイトル（10語以内、${llmRoleNameToUse}の視点から）。このタイトルはファイル名にも使用されます。",
  "tags": [],
  "mood": "会話全体の雰囲気を表す言葉（例: 肯定的, 前向き, 困惑, 達成感など、${llmRoleNameToUse}が感じたもの）。",
  "keyTakeaways": [
    "この会話から得られた最も重要な結論や決定事項を1～3点、${llmRoleNameToUse}の言葉で記述。",
    "（必要なら追加）"
  ],
  "actionItems": [
    "User: （ユーザーが行うべき具体的なアクションがあれば記述。なければ空文字列または省略）",
    "${llmRoleNameToUse}: （${llmRoleNameToUse}自身が行うべき具体的なアクションがあれば記述。なければ空文字列または省略）"
  ],
  "reflectionBody": "以下のMarkdownフォーマットに従って、会話の振り返りを記述してください。\\n## その日の会話のテーマ\\n\\n\\n## 特に印象に残った発言\\n\\n\\n## 新しい発見や気づき\\n\\n\\n## 感情の変化\\n\\n\\n## 今後の課題や目標\\n\\n\\n## 自由形式での感想\\n"
}
\`\`\`
JSONオブジェクトのみを返し、他のテキストは含めないでください。
"reflectionBody"内の改行は \\n としてエスケープしてください。
`;
        console.log("[ConversationReflectionTool DEBUG] Reflection Prompt for LLM:", reflectionPrompt);

        try {
            new Notice(`${llmRoleNameToUse}が会話の振り返り兼サマリーを作成中です...`, 4000);
            console.log('[ConversationReflectionTool DEBUG] Invoking LLM for reflection...');
            const llmResponse = await this.llm.invoke(reflectionPrompt);
            const responseContent = typeof llmResponse.content === 'string' ? llmResponse.content : JSON.stringify(llmResponse.content);
            console.log('[ConversationReflectionTool DEBUG] LLM response content (raw):', responseContent);

            let parsedResponse: ReflectionLLMResponse;
            try {
                const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
                if (jsonMatch && jsonMatch[1]) {
                    parsedResponse = JSON.parse(jsonMatch[1]) as ReflectionLLMResponse;
                } else {
                    parsedResponse = JSON.parse(responseContent) as ReflectionLLMResponse;
                }
                console.log('[ConversationReflectionTool DEBUG] Parsed LLM response:', parsedResponse);
            } catch (parseError: any) {
                console.error("[ConversationReflectionTool DEBUG] Failed to parse LLM response JSON:", parseError, "Raw response was:", responseContent);
                return `エラー: LLMからの応答の解析に失敗しました。応答形式が不正です。詳細はコンソールを確認してください。 (Raw: ${responseContent.substring(0,100)}...)`;
            }

            if (!parsedResponse.conversationTitle || !parsedResponse.reflectionBody) {
                console.error("[ConversationReflectionTool DEBUG] LLM response missing title or body. Title:", parsedResponse.conversationTitle, "Body undefined?:", !parsedResponse.reflectionBody);
                throw new Error("LLMからの応答に必要な情報（タイトルまたは本文）が欠けています。");
            }
            
            const reflectionBodyContent = parsedResponse.reflectionBody.replace(/\\n/g, '\n');
            console.log('[ConversationReflectionTool DEBUG] reflectionBodyContent (after unescaping newlines):', reflectionBodyContent.substring(0, 200) + "...");

            const tagScores = await this.loadTagScores();
            const existingVaultTags = Object.keys(tagScores);
            console.log('[ConversationReflectionTool DEBUG] Existing vault tags for keyword extraction:', existingVaultTags);
            const extractedContentTags = await this.extractTagsFromReflectionBody(reflectionBodyContent, existingVaultTags, llmRoleNameToUse);
            console.log('[ConversationReflectionTool DEBUG] Extracted content tags:', extractedContentTags);


            const normalizedDir = normalizePath(SUMMARY_NOTE_DIR);
            const dirExists = await this.app.vault.adapter.exists(normalizedDir);
            if (!dirExists) {
                console.log(`[ConversationReflectionTool DEBUG] Directory ${normalizedDir} does not exist. Creating...`);
                await this.app.vault.createFolder(normalizedDir);
            }

            const logFileMoment = moment(fullLogFileName.replace(/\.md$/, ''), "YYYYMMDDHHmmss");
            const summaryNoteTimestamp = logFileMoment.isValid() ? logFileMoment.format("YYYYMMDDHHmm") : moment().format("YYYYMMDDHHmm");
            const sanitizedTitle = this.sanitizeTitleForFilename(parsedResponse.conversationTitle);
            const noteFileName = `SN-${summaryNoteTimestamp}-${sanitizedTitle}.md`;
            const filePath = normalizePath(`${normalizedDir}/${noteFileName}`);
            console.log('[ConversationReflectionTool DEBUG] Generated note file path:', filePath);

            const finalTags = Array.from(new Set([llmRoleNameToUse, ...extractedContentTags, ...(parsedResponse.tags || [])]));
            console.log('[ConversationReflectionTool DEBUG] Final tags for frontmatter:', finalTags);

            const frontmatter: SummaryNoteFrontmatter = {
                title: parsedResponse.conversationTitle,
                date: moment().format('YYYY-MM-DD HH:mm:ss'),
                type: 'conversation_summary',
                participants: ['User', llmRoleNameToUse],
                tags: finalTags,
                full_log: `[[${fullLogFileName}]]`,
                mood: parsedResponse.mood || 'Neutral',
                key_takeaways: parsedResponse.keyTakeaways || [],
                action_items: parsedResponse.actionItems || [],
            };
            console.log("[ConversationReflectionTool DEBUG] Frontmatter to be written:", stringifyYaml(frontmatter));


            const fileContent = `---
${stringifyYaml(frontmatter)}---

# ${parsedResponse.conversationTitle} (by ${llmRoleNameToUse})

${reflectionBodyContent}
`;
            console.log("[ConversationReflectionTool DEBUG] Full file content to be written (first 300 chars):", fileContent.substring(0, 300));


            console.log('[ConversationReflectionTool DEBUG] Attempting to create file at:', filePath);
            const createdFile = await this.app.vault.create(filePath, fileContent);
            console.log('[ConversationReflectionTool DEBUG] File creation result:', createdFile ? `Success: ${createdFile.path}` : "Failed or no TFile returned");

            if (!(createdFile instanceof TFile)) {
                console.error("[ConversationReflectionTool DEBUG] File creation did not return a TFile object.");
                throw new Error("振り返りノートファイルの作成に失敗しました (TFileオブジェクトが返されませんでした)。");
            }

            new Notice(`${llmRoleNameToUse}による振り返り(サマリー)が ${createdFile.basename} に保存されました。`);
            console.log(`[ConversationReflectionTool] 振り返り兼サマリーファイルが保存されました: ${filePath}`);

            if (createdFile instanceof TFile && finalTags.length > 0) {
                console.log(`[ConversationReflectionTool DEBUG] Initiating tag profiling for ${createdFile.basename}`); // ★追加
                try {
                    new Notice(`${createdFile.basename} のタグプロファイル処理を開始します...`);
                    await this.tagProfiler.processSummaryNote(createdFile);
                    console.log(`[ConversationReflectionTool DEBUG] Tag profiling completed for ${createdFile.basename}`); // ★追加
                    new Notice(`${createdFile.basename} のタグプロファイル処理が完了しました。`);
                } catch (tpError: any) {
                    console.error(`[ConversationReflectionTool DEBUG] Error during tag profiling for ${createdFile.basename}:`, tpError, tpError.stack); // ★変更
                    new Notice(`${createdFile.basename} のタグプロファイル処理中にエラーが発生しました。`);
                }
            } else {
                console.log(`[ConversationReflectionTool DEBUG] Skipping tag profiling for ${createdFile.basename} because no final tags or not a TFile.`); // ★追加
            }
            return createdFile;

        } catch (error: any) {
            console.error("[ConversationReflectionTool DEBUG] Error during reflection/summary generation or saving:", error, error.stack);
            new Notice(`${llmRoleNameToUse}による振り返り兼サマリーの生成または保存に失敗しました。詳細はコンソールを確認してください。`);
            return `振り返り兼サマリーの生成または保存中にエラーが発生しました: ${error.message}`;
        }
    }

    public async generateAndSaveReflection(history: BaseMessage[], roleName: string, logFileName: string): Promise<string | TFile> {
        const roleNameToUse = roleName && roleName.trim() ? roleName.trim() : (this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName);
        console.log(`[ConversationReflectionTool DEBUG] generateAndSaveReflection called with roleName: ${roleName}, resolved to: ${roleNameToUse}, logFileName: ${logFileName}`); // ★追加
        return this._call({ conversationHistory: history, llmRoleName: roleNameToUse, fullLogFileName: logFileName });
    }
}
