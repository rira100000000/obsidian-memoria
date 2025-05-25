// src/tools/conversationReflectionTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { App, TFile, moment, Notice, normalizePath, stringifyYaml } from 'obsidian';
import { BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import ObsidianMemoria from "../../main";
import { GeminiPluginSettings, DEFAULT_SETTINGS } from "../settings";
import { TagScores, SummaryNoteFrontmatter } from "../types";
import { TagProfiler } from '../tagProfiler';
import { z } from "zod";

interface ReflectionLLMResponse {
    conversationTitle: string;
    tags: string[];
    mood: string;
    keyTakeaways: string[];
    actionItems: string[];
    reflectionBody: string;
}

const ConversationReflectionToolSchema = z.object({
    conversationHistory: z.array(z.object({
        type: z.string().describe("Type of the message (e.g., 'human', 'ai', 'system', 'tool')"),
        content: z.string().describe("Content of the message")
    })).describe("The history of the conversation, including user, AI, and potentially tool messages."),
    llmRoleName: z.string().describe("The role name of the LLM persona making the reflection."),
    fullLogFileName: z.string().describe("The filename of the full conversation log (e.g., 'YYYYMMDDHHmmss.md') that this reflection is based on.")
});
const TAG_SCORES_FILE = 'tag_scores.json';
export type ConversationReflectionToolInput = z.infer<typeof ConversationReflectionToolSchema>;

export class ConversationReflectionTool extends StructuredTool<typeof ConversationReflectionToolSchema> {
    schema = ConversationReflectionToolSchema;

    name = "conversation_reflection_and_summary_tool";
    description = `Analyzes the current conversation from the LLM's perspective and writes a summary note.
Input should be an object with 'conversationHistory' (array of messages with 'type' and 'content'), 'llmRoleName' (string), and 'fullLogFileName' (string).
Use this tool when the conversation seems to be concluding, when a natural point for reflection is reached, or when explicitly asked by the user to summarize or reflect on the conversation.
This tool helps in consolidating learnings and key points from the dialogue into a structured note.`;

    private app: App;
    private plugin: ObsidianMemoria;
    private settings: GeminiPluginSettings;
    private llm: ChatGoogleGenerativeAI | null = null;
    private keywordLlm: ChatGoogleGenerativeAI | null = null;
    private tagProfiler: TagProfiler;
    private toolInstanceId: string; // インスタンスIDを追加

    constructor(plugin: ObsidianMemoria, llm?: ChatGoogleGenerativeAI) {
        super();
        this.plugin = plugin;
        this.app = plugin.app;
        this.settings = plugin.settings;
        this.toolInstanceId = Math.random().toString(36).substring(2, 8); // インスタンスIDを初期化
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}] New instance created.`);
        this.llm = llm || this.initializeLlm();
        this.keywordLlm = this.initializeKeywordLlm();
        this.tagProfiler = new TagProfiler(this.plugin); // TagProfilerもIDを持つとデバッグしやすいかも
    }

    private initializeLlm(): ChatGoogleGenerativeAI | null {
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}] initializeLlm CALLED.`);
        if (this.settings.geminiApiKey && this.settings.geminiModel) {
            try {
                return new ChatGoogleGenerativeAI({
                    apiKey: this.settings.geminiApiKey,
                    model: this.settings.geminiModel,
                });
            } catch (e: any) {
                console.error(`[ConversationReflectionTool][${this.toolInstanceId}] メインLLMの初期化に失敗しました:`, e.message);
                return null;
            }
        }
        console.warn(`[ConversationReflectionTool][${this.toolInstanceId}] Gemini APIキーまたはモデルが設定されていないため、メインLLMを初期化できません。`);
        return null;
    }

    private initializeKeywordLlm(): ChatGoogleGenerativeAI | null {
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}] initializeKeywordLlm CALLED.`);
        const keywordModelName = this.settings.keywordExtractionModel || this.settings.geminiModel;
        if (this.settings.geminiApiKey && keywordModelName) {
            try {
                return new ChatGoogleGenerativeAI({
                    apiKey: this.settings.geminiApiKey,
                    model: keywordModelName,
                });
            } catch (e: any) {
                console.error(`[ConversationReflectionTool][${this.toolInstanceId}] キーワード抽出用LLMの初期化に失敗しました:`, e.message);
                return null;
            }
        }
        console.warn(`[ConversationReflectionTool][${this.toolInstanceId}] Gemini APIキーまたはキーワード抽出用モデルが設定されていないため、キーワード抽出用LLMを初期化できません。`);
        return null;
    }

    public onSettingsChanged(): void {
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}] onSettingsChanged CALLED.`);
        this.settings = this.plugin.settings;
        this.llm = this.initializeLlm();
        this.keywordLlm = this.initializeKeywordLlm();
        if (this.tagProfiler && typeof (this.tagProfiler as any).onSettingsChanged === 'function') {
            (this.tagProfiler as any).onSettingsChanged();
        }
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}] 設定が変更され、LLMおよびTagProfilerが再初期化/更新されました。`);
    }

    private formatConversationHistoryForPrompt(history: Array<{type: string, content: string}>, llmRoleNameToUse: string): string {
        return history
            .map(msg => {
                const speaker = msg.type === "human" ? "User" : (msg.type === "ai" ? llmRoleNameToUse : msg.type);
                return `${speaker}: ${msg.content}`;
            })
            .join("\n\n");
    }

    private async loadTagScores(): Promise<TagScores> {
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}] loadTagScores CALLED.`);
        try {
            const fileExists = await this.app.vault.adapter.exists(TAG_SCORES_FILE);
            if (fileExists) {
                const content = await this.app.vault.adapter.read(TAG_SCORES_FILE);
                return JSON.parse(content) as TagScores;
            }
        } catch (error) {
            console.error(`[ConversationReflectionTool][${this.toolInstanceId}] ${TAG_SCORES_FILE} の読み込みエラー:`, error);
        }
        return {};
    }

    private async extractTagsFromReflectionBody(reflectionBody: string, existingTags: string[], llmRoleName: string): Promise<string[]> {
        const callId = Math.random().toString(36).substring(2, 6);
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] extractTagsFromReflectionBody CALLED.`);
        if (!this.keywordLlm) {
            console.warn(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] キーワード抽出用LLMが利用できないため、タグ抽出をスキップします。`);
            return [];
        }
        // (prompt definition is unchanged)
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
        try {
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] Invoking keywordLlm...`);
            const response = await this.keywordLlm.invoke(keywordExtractionPrompt);
            const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] keywordLlm response received: ${responseContent.substring(0,100)}...`);
            
            let extractedKeywords: string[] = [];
            const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                try {
                    extractedKeywords = JSON.parse(jsonMatch[1]);
                } catch(e: any) {
                    console.error(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] Failed to parse JSON from json block:`, e, "Content was:", jsonMatch[1]);
                    return [];
                }
            } else {
                 try {
                    extractedKeywords = JSON.parse(responseContent);
                } catch (e: any) {
                    console.warn(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] Tag Extraction LLM response was not direct JSON. Error:`, e, "Raw content:", responseContent);
                    if (typeof responseContent === 'string' && !responseContent.startsWith('[')) {
                        extractedKeywords = responseContent.split(',').map(k => k.trim()).filter(k => k.length > 0);
                    } else {
                        return [];
                    }
                }
            }

            if (Array.isArray(extractedKeywords)) {
                const processedTags = extractedKeywords.map(tag =>
                    tag.trim()
                        .replace(/\s+/g, '-') 
                        .replace(/[#,[\]{}|:"<>/\\?*^()']/g, '') 
                        .substring(0, 50) 
                ).filter(tag => tag.length > 0);
                console.log(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] Processed tags:`, processedTags);
                return processedTags;
            }
            console.warn(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] Extracted keywords is not an array.`);
            return [];
        } catch (error) {
            console.error(`[ConversationReflectionTool][${this.toolInstanceId}][TagExtract-${callId}] Error during tag extraction:`, error);
            return [];
        }
    }

    private sanitizeTitleForFilename(title: string): string {
        return title.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, '_').substring(0, 50);
    }

    protected async _call(input: ConversationReflectionToolInput): Promise<TFile | string> {
        const callId = Math.random().toString(36).substring(2, 8); // この呼び出し固有のID
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] _call CALLED with input:`, JSON.stringify(input).substring(0, 200) + "...");

        if (!this.llm) {
            const errorMsg = "エラー: メインLLMが初期化されていません。APIキーとモデル設定を確認してください。";
            console.error(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] ${errorMsg}`);
            return errorMsg;
        }

        const { conversationHistory, llmRoleName, fullLogFileName } = input;
        const llmRoleNameToUse = (llmRoleName && llmRoleName.trim()) ? llmRoleName.trim() : (this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName);

        if (!fullLogFileName || !fullLogFileName.trim()) {
            console.error(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] fullLogFileName is missing.`);
            return "エラー: fullLogFileName が提供されていません。";
        }
        if (!conversationHistory || conversationHistory.length === 0) {
            console.warn(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] No conversation history provided.`);
            return "エラー: 振り返りを生成するための会話履歴が提供されていません。";
        }

        const formattedHistory = this.formatConversationHistoryForPrompt(conversationHistory, llmRoleNameToUse);
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
        try {
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Displaying Notice: ${llmRoleNameToUse}が会話の振り返り兼サマリーを作成中です...`);
            new Notice(`${llmRoleNameToUse}が会話の振り返り兼サマリーを作成中です...`, 4000);
            
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Invoking main LLM for reflection...`);
            const llmResponse = await this.llm.invoke(reflectionPrompt);
            const responseContent = typeof llmResponse.content === 'string' ? llmResponse.content : JSON.stringify(llmResponse.content);
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Main LLM response received: ${responseContent.substring(0,200)}...`);
            
            let parsedResponse: ReflectionLLMResponse;
            try {
                const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
                if (jsonMatch && jsonMatch[1]) {
                    parsedResponse = JSON.parse(jsonMatch[1]) as ReflectionLLMResponse;
                } else {
                    parsedResponse = JSON.parse(responseContent) as ReflectionLLMResponse;
                }
                console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] LLM response parsed successfully.`);
            } catch (parseError: any) {
                console.error(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Failed to parse LLM response JSON:`, parseError, "Raw response:", responseContent);
                return `エラー: LLMからの応答の解析に失敗しました。応答形式が不正です。詳細はコンソールを確認してください。 (Raw: ${responseContent.substring(0,100)}...)`;
            }

            if (!parsedResponse.conversationTitle || !parsedResponse.reflectionBody) {
                console.error(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] LLM response missing title or body. Parsed:`, parsedResponse);
                return "エラー: LLMからの応答に必要な情報（タイトルまたは本文）が欠けています。";
            }
            
            const reflectionBodyContent = parsedResponse.reflectionBody.replace(/\\n/g, '\n');
            const tagScores = await this.loadTagScores(); // 内部でログ出力あり
            const existingVaultTags = Object.keys(tagScores);
            const extractedContentTags = await this.extractTagsFromReflectionBody(reflectionBodyContent, existingVaultTags, llmRoleNameToUse); // 内部でログ出力あり

            const summaryNoteDir = 'SummaryNote';
            const normalizedDir = normalizePath(summaryNoteDir);
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Checking/creating directory: ${normalizedDir}`);
            const dirExists = await this.app.vault.adapter.exists(normalizedDir);
            if (!dirExists) {
                await this.app.vault.createFolder(normalizedDir);
                console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Directory created: ${normalizedDir}`);
            }

            const logFileMoment = moment(fullLogFileName.replace(/\.md$/, ''), "YYYYMMDDHHmmss");
            const summaryNoteTimestamp = logFileMoment.isValid() ? logFileMoment.format("YYYYMMDDHHmm") : moment().format("YYYYMMDDHHmm");
            const sanitizedTitle = this.sanitizeTitleForFilename(parsedResponse.conversationTitle);
            const noteFileName = `SN-${summaryNoteTimestamp}-${sanitizedTitle}.md`;
            const filePath = normalizePath(`${normalizedDir}/${noteFileName}`);
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Determined file path: ${filePath}`);

            const finalTags = Array.from(new Set([llmRoleNameToUse, ...extractedContentTags, ...(parsedResponse.tags || [])]));
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Final tags for note:`, finalTags);

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

            const fileContent = `---
${stringifyYaml(frontmatter)}---

# ${parsedResponse.conversationTitle} (by ${llmRoleNameToUse})

${reflectionBodyContent}
`;
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Creating file at: ${filePath}`);
            const createdFile = await this.app.vault.create(filePath, fileContent);
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] File creation result (instanceof TFile): ${createdFile instanceof TFile}. Path: ${createdFile.path}`);

            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Displaying Notice: ${llmRoleNameToUse}による振り返り(サマリー)が ${createdFile.basename} に保存されました。`);
            new Notice(`${llmRoleNameToUse}による振り返り(サマリー)が ${createdFile.basename} に保存されました。`);
            
            if (finalTags.length > 0) {
                console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Starting tag profiling for ${createdFile.basename}...`);
                try {
                    console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Displaying Notice: ${createdFile.basename} のタグプロファイル処理を開始します...`);
                    new Notice(`${createdFile.basename} のタグプロファイル処理を開始します...`);
                    await this.tagProfiler.processSummaryNote(createdFile); // TagProfiler内部のログに期待
                    console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Tag profiling completed for ${createdFile.basename}.`);
                    console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Displaying Notice: ${createdFile.basename} のタグプロファイル処理が完了しました。`);
                    new Notice(`${createdFile.basename} のタグプロファイル処理が完了しました。`);
                } catch (tpError: any) {
                    console.error(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Error during tag profiling for ${createdFile.basename}:`, tpError, tpError.stack);
                    console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] Displaying Notice: ${createdFile.basename} のタグプロファイル処理中にエラーが発生しました。`);
                    new Notice(`${createdFile.basename} のタグプロファイル処理中にエラーが発生しました。`);
                }
            }
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] _call FINISHED successfully. Returning TFile.`);
            return createdFile;

        } catch (error: any) {
            console.error(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] UNEXPECTED ERROR in _call:`, error, error.stack);
            // このNoticeはChatSessionManager側でも表示される可能性があるため、重複を避けるか、どちらかに統一するか検討。
            // ここではTool内部のエラーとして残し、ChatSessionManager側ではToolからの戻り値を見て判断する。
            // new Notice(`${llmRoleNameToUse}による振り返り兼サマリーの生成または保存に失敗しました。詳細はコンソールを確認してください。`);
            const errorMessage = `エラー: ${llmRoleNameToUse}による振り返り兼サマリーの生成または保存に失敗しました。詳細: ${error.message}`;
            console.log(`[ConversationReflectionTool][${this.toolInstanceId}][_call-${callId}] _call FINISHED with error. Returning error string: ${errorMessage}`);
            return errorMessage;
        }
    }

    public async generateAndSaveReflection(history: BaseMessage[], roleName: string, logFileName: string): Promise<TFile | string> {
        const callId = Math.random().toString(36).substring(2, 8);
        console.log(`[ConversationReflectionTool][${this.toolInstanceId}][GenSave-${callId}] generateAndSaveReflection CALLED. Delegating to _call.`);
        return this._call({
            conversationHistory: history.map(msg => ({ type: msg._getType(), content: String(msg.content) })),
            llmRoleName: roleName && roleName.trim() ? roleName.trim() : (this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName),
            fullLogFileName: logFileName
        });
    }
}
