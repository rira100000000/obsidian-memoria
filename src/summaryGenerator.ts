// src/summaryGenerator.ts
import { App, Notice, TFile, moment, stringifyYaml } from 'obsidian';
import ObsidianMemoria from '../main';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GeminiPluginSettings } from './settings'; // settings.ts のパスをプロジェクト構成に合わせてください

export class SummaryGenerator {
    private plugin: ObsidianMemoria;
    private app: App;
    private settings: GeminiPluginSettings;
    private chatModel: ChatGoogleGenerativeAI | null = null;

    constructor(plugin: ObsidianMemoria) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.settings = plugin.settings;
        this.initializeChatModel();
    }

    private initializeChatModel() {
        if (this.settings.geminiApiKey && this.settings.geminiModel) {
            try {
                this.chatModel = new ChatGoogleGenerativeAI({
                    apiKey: this.settings.geminiApiKey,
                    model: this.settings.geminiModel, // Consider a model optimized for summarization/extraction if available
                });
                console.log('[SummaryGenerator] ChatGoogleGenerativeAI model initialized for summarization.');
            } catch (error: any) {
                console.error("[SummaryGenerator] Failed to initialize ChatGoogleGenerativeAI model:", error.message);
                this.chatModel = null;
            }
        } else {
            console.log('[SummaryGenerator] API key or model name not set for summarization. LLM not initialized.');
            this.chatModel = null;
        }
    }

    // 設定変更時にモデルを再初期化するメソッド (オプション)
    public onSettingsChanged() {
        this.settings = this.plugin.settings; // 最新の設定を読み込む
        this.initializeChatModel();
        console.log('[SummaryGenerator] Settings changed, chat model re-initialized.');
    }
    
    private sanitizeTitleForFilename(title: string): string {
        // ファイル名に使えない文字を除去または置換し、長さを制限
        return title.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, '_').substring(0, 50);
    }

           private buildPrompt(llmRoleName: string, conversationContent: string): string {
        // LLMに指示するプロンプトを構築
        return `
You are an AI assistant tasked with summarizing a conversation log from a chat application.
The conversation is between "User" and "${llmRoleName}".
The full conversation log is provided below:
---
${conversationContent}
---

Based on this conversation, please perform the following:
1.  Determine the primary language used in the conversation log (e.g., English, Japanese, Spanish).
2.  Generate ALL textual content for the JSON fields below (especially conversationTitle, keyTakeaways, actionItems, mainTopics, summaryBody, userInsights, llmInsights, and relatedInformation) IN THE SAME LANGUAGE as the primary language identified in step 1. For example, if the conversation is in Japanese, the summaryBody and conversationTitle must also be in Japanese.
3.  Provide the information in a VALID JSON format.
Ensure all string values are properly escaped within the JSON.
Do not include any text outside the JSON block, not even "json" or backticks.

{
  "conversationTitle": "A concise and descriptive title for the conversation (max 10 words). This title MUST be in the primary language of the conversation.",
  "tags": ["TagA", "TagB", "RelevantKeyword"],
  "mood": "Overall mood of the conversation (Positive, Negative, Neutral, or Mixed). This should be in the primary language of the conversation if applicable (e.g., '肯定的', '否定的'), or English if a direct translation is awkward.",
  "keyTakeaways": [
    "Key conclusion or decision 1. (MUST be in the primary language of the conversation)",
    "Key conclusion or decision 2. (MUST be in the primary language of the conversation)"
  ],
  "actionItems": [
    "User: Action item for User (e.g., 'User: Research topic Y'). (MUST be in the primary language of the conversation)",
    "${llmRoleName}: Action item for ${llmRoleName} (e.g., '${llmRoleName}: Remind about Z next meeting'). (MUST be in the primary language of the conversation)"
  ],
  "mainTopics": [
    "Main topic 1 discussed. (MUST be in the primary language of the conversation)",
    "Main topic 2 discussed. (MUST be in the primary language of the conversation)"
  ],
  "summaryBody": "A concise summary of the conversation's main points, written in a narrative style. This summary MUST be in the primary language of the conversation.",
  "userInsights": {
    "mainStatements": [
      "Quote or paraphrase of user's key statement 1. (MUST be in the primary language of the conversation)",
      "Quote or paraphrase of user's key statement 2. (MUST be in the primary language of the conversation)"
    ],
    "observedEmotions": [
      "User seemed pleased when discussing the positive feedback. (MUST be in the primary language of the conversation)",
      "User expressed some concern regarding the deadline. (MUST be in the primary language of the conversation)"
    ]
  },
  "llmInsights": {
    "mainResponses": [
      "${llmRoleName} provided details about feature X. (MUST be in the primary language of the conversation)",
      "${llmRoleName} acknowledged user's suggestion. (MUST be in the primary language of the conversation)"
    ],
    "rolePlayed": "Brief description of the role ${llmRoleName} played (e.g., 'information provider', 'problem solver', 'empathetic listener'). This description MUST be in the primary language of the conversation."
  },
  "relatedInformation": [
    "Reference to a related document, link, or topic mentioned in the conversation (e.g., '[[OtherNoteTitle]]', 'User mentioned the report from last week'). (MUST be in the primary language of the conversation)"
  ] // Provide an empty array [] if no specific related documents, links, or explicitly related topics for cross-referencing are mentioned in the log.
}
`;
    }


    async generateSummary(fullLogPath: string, llmRoleName: string): Promise<void> {
        if (!this.chatModel) {
            new Notice("サマリー生成: LLMが初期化されていません。設定を確認してください。");
            console.error("[SummaryGenerator] LLM for summarization is not initialized.");
            return;
        }

        const fullLogFile = this.app.vault.getAbstractFileByPath(fullLogPath);
        if (!(fullLogFile instanceof TFile)) {
            new Notice(`サマリー生成: ログファイルが見つかりません: ${fullLogPath}`);
            console.error(`[SummaryGenerator] Full log file not found: ${fullLogPath}`);
            return;
        }

        const fullLogContent = await this.app.vault.cachedRead(fullLogFile);
        // フロントマターを除いた会話内容を取得
        const conversationContentMatch = fullLogContent.match(/---\s*[\s\S]*?---([\s\S]*)/);
        const conversationContent = conversationContentMatch && conversationContentMatch[1] ? conversationContentMatch[1].trim() : fullLogContent;


        const prompt = this.buildPrompt(llmRoleName, conversationContent);
        
        let llmResponseJson;
        try {
            console.log("[SummaryGenerator] Sending prompt to LLM for summarization...");
            const response = await this.chatModel.invoke(prompt);
            const responseContent = response.content;

            if (typeof responseContent !== 'string') {
                throw new Error("LLM response content is not a string.");
            }
            
            // JSONが```json ... ```で囲まれている場合も考慮
            const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
            const jsonStringToParse = jsonMatch && jsonMatch[1] ? jsonMatch[1] : responseContent;
            
            llmResponseJson = JSON.parse(jsonStringToParse);
            console.log("[SummaryGenerator] Successfully parsed LLM response.");

        } catch (error: any) {
            console.error("[SummaryGenerator] Error calling LLM or parsing JSON response:", error.message, error.stack);
            new Notice("LLMからの要約データ取得または解析に失敗しました。");
            return;
        }
        
        const {
            conversationTitle, tags, mood, keyTakeaways, actionItems,
            mainTopics, summaryBody, userInsights, llmInsights, relatedInformation
        } = llmResponseJson;

        if (!conversationTitle || typeof conversationTitle !== 'string' || conversationTitle.trim() === "") {
            console.error("[SummaryGenerator] Conversation title missing or invalid from LLM response.");
            new Notice("LLMが会話タイトルを提供しませんでした。デフォルトタイトルを使用します。");
            // フォールバックタイトルを設定することも検討
            // conversationTitle = "Untitled Conversation"; 
            return; // タイトルがないとファイル名が作れないので中断
        }

        // SummaryNoteディレクトリ作成
        const summaryDir = 'SummaryNote';
        try {
            const dirExists = await this.app.vault.adapter.exists(summaryDir);
            if (!dirExists) {
                await this.app.vault.createFolder(summaryDir);
                console.log(`[SummaryGenerator] Created directory: ${summaryDir}`);
            }
        } catch (error: any) {
             console.error(`[SummaryGenerator] Error creating directory ${summaryDir}:`, error.message);
             new Notice(`${summaryDir}ディレクトリの作成に失敗しました。`);
             return;
        }
        
        const logFileBasename = fullLogFile.basename; // YYYYMMDDHHmmss
        const logFileMoment = moment(logFileBasename, "YYYYMMDDHHmmss");
        const summaryNoteTimestamp = logFileMoment.isValid() ? logFileMoment.format("YYYYMMDDHHmm") : moment().format("YYYYMMDDHHmm"); // Fallback to current time if parsing fails

        const sanitizedTitle = this.sanitizeTitleForFilename(conversationTitle);
        const summaryNoteFilename = `SN-${summaryNoteTimestamp}-${sanitizedTitle}.md`;
        const summaryNotePath = `${summaryDir}/${summaryNoteFilename}`;
        
        const summaryNoteCreationDate = moment().format('YYYY-MM-DD HH:mm:ss');

        const summaryFrontMatter = {
            title: conversationTitle,
            date: summaryNoteCreationDate,
            type: 'conversation_summary',
            participants: ['User', llmRoleName],
            tags: Array.isArray(tags) ? tags : [],
            full_log: `[[${fullLogFile.name}]]`, // 正しいFullLogファイル名へのリンク
            mood: mood || 'Neutral',
            key_takeaways: Array.isArray(keyTakeaways) ? keyTakeaways : [],
            action_items: Array.isArray(actionItems) ? actionItems : [],
        };
        
        let summaryNoteContent = `---\n${stringifyYaml(summaryFrontMatter)}---\n\n`;
        summaryNoteContent += `# 会話要約: ${conversationTitle}\n\n`;
        summaryNoteContent += `**日時**: ${summaryNoteCreationDate}\n`;
        summaryNoteContent += `**参加者**: User, ${llmRoleName}\n\n`;

        summaryNoteContent += `## 主要トピック\n${(Array.isArray(mainTopics) ? mainTopics : []).map((t:string) => `- ${t}`).join('\n')}\n\n`;
        summaryNoteContent += `## 要約\n${summaryBody || '要約は利用できません。'}\n\n`;
        
        summaryNoteContent += `## ユーザーの主な発言・感情\n`;
        if (userInsights && typeof userInsights === 'object') {
            summaryNoteContent += `${(Array.isArray(userInsights.mainStatements) ? userInsights.mainStatements : []).map((s:string) => `- 「${s}」`).join('\n')}\n`;
            summaryNoteContent += `${(Array.isArray(userInsights.observedEmotions) ? userInsights.observedEmotions : []).map((e:string) => `- ${e}`).join('\n')}\n\n`;
        } else {
            summaryNoteContent += `N/A\n\n`;
        }

        summaryNoteContent += `## ${llmRoleName}の主な応答・役割\n`;
        if (llmInsights && typeof llmInsights === 'object') {
            summaryNoteContent += `${(Array.isArray(llmInsights.mainResponses) ? llmInsights.mainResponses : []).map((r:string) => `- ${r}`).join('\n')}\n`;
            summaryNoteContent += `- 役割: ${llmInsights.rolePlayed || 'N/A'}\n\n`;
        } else {
            summaryNoteContent += `N/A\n\n`;
        }
        if (Array.isArray(relatedInformation) && relatedInformation.length > 0) {
            summaryNoteContent += `## 関連情報\n`;
            summaryNoteContent += relatedInformation.map((item: string) => `- ${item}`).join('\n') + '\n\n';
        }

        try {
            const existingSummary = this.app.vault.getAbstractFileByPath(summaryNotePath);
            if (existingSummary) {
                new Notice(`サマリーノートは既に存在します: ${summaryNoteFilename}`);
                console.warn(`[SummaryGenerator] Summary note already exists: ${summaryNotePath}. Skipping creation.`);
                 // 既存のノートがある場合でもFullLogの更新は試みる
            } else {
                await this.app.vault.create(summaryNotePath, summaryNoteContent);
                new Notice(`サマリーノート作成: ${summaryNoteFilename}`);
                console.log(`[SummaryGenerator] Summary note created: ${summaryNotePath}`);
            }


            // FullLogのフロントマターを更新
            await this.app.fileManager.processFrontMatter(fullLogFile, (fm) => {
                fm.title = conversationTitle;
                fm.summary_note = `[[${summaryNoteFilename}]]`; // SummaryNoteファイル名（パスなし）
            });
            console.log(`[SummaryGenerator] FullLog (${fullLogPath}) のフロントマターを更新しました。`);

        } catch (error: any) {
            console.error("[SummaryGenerator] サマリーノート作成またはFullLog更新エラー:", error.message, error.stack);
            new Notice("サマリーノート作成またはFullLog更新中にエラーが発生しました。");
        }
    }
}