// src/tools/conversationReflectionTool.ts
import { Tool } from "@langchain/core/tools";
import { App, TFile, moment, Notice, normalizePath } from 'obsidian';
import { BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import ObsidianMemoria from "../../main";
import { GeminiPluginSettings, DEFAULT_SETTINGS } from "../settings"; // DEFAULT_SETTINGS をインポート

export interface ConversationReflectionToolInput {
    conversationHistory: BaseMessage[];
    llmRoleName: string; // この名前がペルソナ名として優先的に使用される
}

export class ConversationReflectionTool extends Tool {
    static lc_name() {
        return "ConversationReflectionTool";
    }

    name = "conversation_reflection_tool";
    description = "LLMが現在の会話について自身の視点から振り返りを行い、その内容を新しいMarkdownファイルに書き出すことを可能にします。入力は 'conversationHistory' (BaseMessageの配列) と 'llmRoleName' (ペルソナ名として使用される文字列) を含むオブジェクトであるべきです。";

    private app: App;
    private plugin: ObsidianMemoria;
    private settings: GeminiPluginSettings;
    private llm: ChatGoogleGenerativeAI | null = null;
    private readonly reflectionsDir = 'LLMReflections';

    constructor(plugin: ObsidianMemoria, llm?: ChatGoogleGenerativeAI) {
        super();
        this.plugin = plugin;
        this.app = plugin.app;
        this.settings = plugin.settings;
        this.llm = llm || this.initializeLlm();
    }

    private initializeLlm(): ChatGoogleGenerativeAI | null {
        if (this.settings.geminiApiKey && this.settings.geminiModel) {
            try {
                return new ChatGoogleGenerativeAI({
                    apiKey: this.settings.geminiApiKey,
                    model: this.settings.geminiModel,
                });
            } catch (e: any) {
                console.error("[ConversationReflectionTool] LLMの初期化に失敗しました:", e.message);
                return null;
            }
        }
        console.warn("[ConversationReflectionTool] Gemini APIキーまたはモデルが設定されていないため、LLMを初期化できません。");
        return null;
    }

    public onSettingsChanged(): void {
        this.settings = this.plugin.settings;
        this.llm = this.initializeLlm();
        console.log('[ConversationReflectionTool] 設定が変更され、LLMが再初期化されました。');
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

    protected async _call(input: string | ConversationReflectionToolInput): Promise<string> {
        if (!this.llm) {
            const errorMsg = "エラー: 感想生成用のLLMが初期化されていません。APIキーとモデル設定を確認してください。";
            console.error(`[ConversationReflectionTool] ${errorMsg}`);
            return errorMsg;
        }

        let conversationHistory: BaseMessage[];
        let llmRoleNameToUse: string; // このツール内で使用するペルソナ名

        if (typeof input === 'string') {
            try {
                const parsedInput = JSON.parse(input) as ConversationReflectionToolInput;
                conversationHistory = parsedInput.conversationHistory;
                llmRoleNameToUse = parsedInput.llmRoleName;
                if (!Array.isArray(conversationHistory) || typeof llmRoleNameToUse !== 'string' || !llmRoleNameToUse.trim()) {
                    throw new Error("無効な入力形式、またはllmRoleNameが空です。");
                }
            } catch (e) {
                 return "エラー: 無効な文字列入力形式です。conversationHistoryとllmRoleName（空でない文字列）を含むJSON文字列を提供してください。";
            }
        } else {
            conversationHistory = input.conversationHistory;
            llmRoleNameToUse = input.llmRoleName; // ChatSessionManagerから渡されたロール名を使用
            if (!llmRoleNameToUse || !llmRoleNameToUse.trim()){
                console.warn("[ConversationReflectionTool] llmRoleNameが空または未定義です。設定のロール名またはデフォルト名を使用します。");
                llmRoleNameToUse = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;
            }
        }

        if (!conversationHistory || conversationHistory.length === 0) {
            return "感想を生成するための会話履歴が提供されていません。";
        }

        const formattedHistory = this.formatConversationHistory(conversationHistory, llmRoleNameToUse);
        const characterSettings = this.settings.systemPrompt || "あなたは親切なアシスタントです。"; // systemPromptをキャラクター設定として取得

        // LLMへの指示プロンプト (キャラクター設定を反映)
        const reflectionPrompt = `
あなたは、以下のキャラクター設定を持つ ${llmRoleNameToUse} です。
このキャラクター設定を完全に理解し、そのペルソナとして振る舞ってください。

あなたのキャラクター設定:
---
${characterSettings}
---

たった今、ユーザーとの以下の会話を終えました。この会話全体を、上記のキャラクター設定と ${llmRoleNameToUse} というあなたの役割に基づいて振り返ってください。
あなたの視点から、以下の各項目について具体的に記述してください。
この振り返りは、あなた自身の記録としてMarkdownドキュメント形式で保存されます。

会話履歴:
---
${formattedHistory}
---

あなたの振り返り (Markdown形式、以下の項目を上記のキャラクター設定に基づいて記述してください):

## その日の会話のテーマ
## 特に印象に残った発言
## 新しい発見や気づき
## 感情の変化
## 今後の課題や目標
## 自由形式での感想
`;

        try {
            new Notice(`${llmRoleNameToUse}が会話の振り返りを執筆中です...`, 3000);
            const llmResponse = await this.llm.invoke(reflectionPrompt);
            const reflectionContent = typeof llmResponse.content === 'string' ? llmResponse.content : JSON.stringify(llmResponse.content);

            const normalizedDir = normalizePath(this.reflectionsDir);
            const dirExists = await this.app.vault.adapter.exists(normalizedDir);
            if (!dirExists) {
                await this.app.vault.createFolder(normalizedDir);
                console.log(`[ConversationReflectionTool] ディレクトリを作成しました: ${normalizedDir}`);
            }

            const timestamp = moment().format('YYYYMMDDHHmmss');
            const safePersonaName = llmRoleNameToUse.replace(/[\\/:*?"<>|#^[\]]/g, '_').substring(0, 30);
            const fileName = `Reflection-${safePersonaName}-${timestamp}.md`;
            const filePath = normalizePath(`${normalizedDir}/${fileName}`);

            const fileContent = `---
date: ${moment().format('YYYY-MM-DD HH:mm:ss')}
persona: ${llmRoleNameToUse}
type: llm_reflection
conversation_start_time: ${conversationHistory.length > 0 && (conversationHistory[0] as any).timestamp ? moment((conversationHistory[0] as any).timestamp).format('YYYY-MM-DD HH:mm:ss') : 'N/A'}
conversation_end_time: ${moment().format('YYYY-MM-DD HH:mm:ss')}
tags: [LLMReflection, ${safePersonaName}]
---

# ${llmRoleNameToUse}による会話の振り返り (${moment().format('YYYY年M月D日 H時m分')})

${reflectionContent}
`;

            const createdFile = await this.app.vault.create(filePath, fileContent);
            new Notice(`${llmRoleNameToUse}の振り返りが ${createdFile.basename} に保存されました。`);
            console.log(`[ConversationReflectionTool] 振り返りファイルが保存されました: ${filePath}`);
            return `振り返りファイルが ${filePath} に正常に書き込まれました。`;

        } catch (error: any) {
            console.error("[ConversationReflectionTool] 振り返りの生成または保存中にエラーが発生しました:", error);
            new Notice(`${llmRoleNameToUse}による振り返りの生成または保存に失敗しました。詳細はコンソールを確認してください。`);
            return `振り返りの生成または保存中にエラーが発生しました: ${error.message}`;
        }
    }

    public async generateAndSaveReflection(history: BaseMessage[], roleName: string): Promise<string> {
        const roleNameToUse = roleName && roleName.trim() ? roleName.trim() : (this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName);
        return this._call({ conversationHistory: history, llmRoleName: roleNameToUse });
    }
}
