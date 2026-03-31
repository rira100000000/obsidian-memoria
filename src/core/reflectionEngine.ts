// src/core/reflectionEngine.ts
import { stringify as stringifyYaml } from 'yaml';
import { StorageAdapter } from './interfaces/storageAdapter';
import { LLMAdapter } from './interfaces/llmAdapter';
import { NotificationAdapter } from './interfaces/notificationAdapter';
import { TagScores, SummaryNoteFrontmatter } from './types';
import { TagProfiler } from './tagProfiler';
import { EmbeddingStore } from './embeddingStore';
import { GeminiPluginSettings, DEFAULT_SETTINGS } from '../settings';
import { GeminiLLMAdapter } from '../adapters/geminiLLMAdapter';

interface ReflectionLLMResponse {
  conversationTitle: string;
  tags: string[];
  mood: string;
  keyTakeaways: string[];
  actionItems: string[];
  reflectionBody: string;
}

export interface ConversationMessage {
  role: 'human' | 'ai' | 'system' | 'tool';
  content: string;
}

export interface ConversationRecord {
  messages: ConversationMessage[];
  llmRoleName: string;
  fullLogFileName: string;
}

export interface ReflectionResult {
  filePath: string;
  baseName: string;
  tags: string[];
  success: boolean;
  error?: string;
}

const TAG_SCORES_FILE = 'tag_scores.json';

export class ReflectionEngine {
  private storage: StorageAdapter;
  private llm: LLMAdapter;
  private notify: NotificationAdapter;
  private tagProfiler: TagProfiler;
  private embeddingStore: EmbeddingStore | null;
  private settings: GeminiPluginSettings;
  private lastResult: ReflectionResult | null = null;

  constructor(
    storage: StorageAdapter,
    llm: LLMAdapter,
    notify: NotificationAdapter,
    tagProfiler: TagProfiler,
    embeddingStore: EmbeddingStore | null,
    settings: GeminiPluginSettings
  ) {
    this.storage = storage;
    this.llm = llm;
    this.notify = notify;
    this.tagProfiler = tagProfiler;
    this.embeddingStore = embeddingStore;
    this.settings = settings;
  }

  public onSettingsChanged(settings: GeminiPluginSettings, embeddingStore?: EmbeddingStore | null): void {
    this.settings = settings;
    if (embeddingStore !== undefined) {
      this.embeddingStore = embeddingStore;
    }
    this.tagProfiler.onSettingsChanged(settings);
  }

  /** このセッションで最後に生成された振り返り結果を取得する */
  public getLastResult(): ReflectionResult | null {
    return this.lastResult;
  }

  /** セッションリセット時に呼び出す */
  public clearLastResult(): void {
    this.lastResult = null;
  }

  /**
   * タイムスタンプ文字列を生成する（moment依存を避けるためのユーティリティ）
   */
  private formatTimestamp(format: 'datetime' | 'compact' | 'compactMinutes'): string {
    const now = new Date();
    const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
    const Y = now.getFullYear();
    const M = pad(now.getMonth() + 1);
    const D = pad(now.getDate());
    const h = pad(now.getHours());
    const m = pad(now.getMinutes());
    const s = pad(now.getSeconds());

    switch (format) {
      case 'datetime': return `${Y}-${M}-${D} ${h}:${m}:${s}`;
      case 'compact': return `${Y}${M}${D}${h}${m}${s}`;
      case 'compactMinutes': return `${Y}${M}${D}${h}${m}`;
    }
  }

  /**
   * ログファイル名からタイムスタンプを抽出する
   */
  private extractTimestampFromLogFile(logFileName: string): string {
    const cleaned = logFileName.replace(/\.md$/, '');
    // YYYYMMDDHHmmss 形式の14桁数字が含まれていればコンパクト分形式に変換
    const match = cleaned.match(/(\d{12})/);
    if (match) {
      return match[1]; // 12桁ならそのまま使用
    }
    // 14桁の場合先頭12桁
    const match14 = cleaned.match(/(\d{14})/);
    if (match14) {
      return match14[1].substring(0, 12);
    }
    return this.formatTimestamp('compactMinutes');
  }

  public async generateReflection(conversation: ConversationRecord): Promise<ReflectionResult> {
    const { messages, llmRoleName, fullLogFileName } = conversation;
    const llmRoleNameToUse = (llmRoleName && llmRoleName.trim()) ? llmRoleName.trim() : (this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName);

    if (!this.llm.isAvailable()) {
      return { filePath: '', baseName: '', tags: [], success: false, error: "エラー: メインLLMが初期化されていません。APIキーとモデル設定を確認してください。" };
    }

    if (!fullLogFileName || !fullLogFileName.trim()) {
      return { filePath: '', baseName: '', tags: [], success: false, error: "エラー: fullLogFileName が提供されていません。" };
    }
    if (!messages || messages.length === 0) {
      return { filePath: '', baseName: '', tags: [], success: false, error: "エラー: 振り返りを生成するための会話履歴が提供されていません。" };
    }

    const formattedHistory = this.formatConversationHistory(messages, llmRoleNameToUse);
    const characterSettings = this.settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt;

    const reflectionPrompt = this.buildReflectionPrompt(llmRoleNameToUse, characterSettings, formattedHistory);

    try {
      this.notify.info(`${llmRoleNameToUse}が会話の振り返り兼サマリーを作成中です...`);
      this.notify.debug('振り返り', `LLMで振り返りを生成中... (会話ターン数: ${messages.length})`);

      if (this.llm instanceof GeminiLLMAdapter) {
        (this.llm as GeminiLLMAdapter).setNextCallLabel('Reflection (サマリーノート生成)');
      }
      const responseContent = await this.llm.generate(reflectionPrompt);
      this.notify.debug('振り返り', 'LLM応答を受信、JSONを解析中...');

      let parsedResponse: ReflectionLLMResponse;
      try {
        const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
        parsedResponse = jsonMatch && jsonMatch[1]
          ? JSON.parse(jsonMatch[1])
          : JSON.parse(responseContent);
      } catch (parseError: any) {
        this.notify.debug('振り返り', `JSON解析エラー: ${parseError.message}`);
        return { filePath: '', baseName: '', tags: [], success: false, error: `エラー: LLMからの応答の解析に失敗しました。(Raw: ${responseContent.substring(0, 100)}...)` };
      }

      if (!parsedResponse.conversationTitle || !parsedResponse.reflectionBody) {
        return { filePath: '', baseName: '', tags: [], success: false, error: "エラー: LLMからの応答に必要な情報（タイトルまたは本文）が欠けています。" };
      }

      const reflectionBodyContent = parsedResponse.reflectionBody.replace(/\\n/g, '\n');
      const tagScores = await this.loadTagScores();
      const existingVaultTags = Object.keys(tagScores);
      const extractedContentTags = await this.extractTagsFromReflectionBody(reflectionBodyContent, existingVaultTags);

      const summaryNoteDir = 'SummaryNote';
      await this.storage.ensureDir(summaryNoteDir);

      const summaryNoteTimestamp = this.extractTimestampFromLogFile(fullLogFileName);
      const sanitizedTitle = this.sanitizeTitleForFilename(parsedResponse.conversationTitle);
      const noteFileName = `SN-${summaryNoteTimestamp}-${sanitizedTitle}.md`;
      const filePath = `${summaryNoteDir}/${noteFileName}`;

      const finalTags = Array.from(new Set([llmRoleNameToUse, ...extractedContentTags, ...(parsedResponse.tags || [])]));
      this.notify.debug('振り返り', `タイトル: ${parsedResponse.conversationTitle}  タグ: ${finalTags.join(', ')}  気分: ${parsedResponse.mood || 'N/A'}`);

      const frontmatter: SummaryNoteFrontmatter = {
        title: parsedResponse.conversationTitle,
        date: this.formatTimestamp('datetime'),
        type: 'conversation_summary',
        participants: ['User', llmRoleNameToUse],
        tags: finalTags,
        full_log: `[[${fullLogFileName}]]`,
        mood: parsedResponse.mood || 'Neutral',
        key_takeaways: parsedResponse.keyTakeaways || [],
        action_items: parsedResponse.actionItems || [],
      };

      const fileContent = `---\n${stringifyYaml(frontmatter)}---\n\n# ${parsedResponse.conversationTitle} (by ${llmRoleNameToUse})\n\n${reflectionBodyContent}\n`;

      await this.storage.write(filePath, fileContent);
      const createdBaseName = noteFileName.replace(/\.md$/, '');

      this.notify.debug('振り返り', `サマリーノート作成完了: ${createdBaseName}`);
      this.notify.info(`${llmRoleNameToUse}による振り返り(サマリー)が ${createdBaseName} に保存されました。`);

      // SN作成後にセマンティック検索インデックスを更新
      await this.embedSummaryNote(filePath, fileContent, parsedResponse.conversationTitle, finalTags);

      // タグプロファイリング
      if (finalTags.length > 0) {
        await this.processTagProfiling(filePath, finalTags, createdBaseName);
      }

      const result: ReflectionResult = { filePath, baseName: createdBaseName, tags: finalTags, success: true };
      this.lastResult = result;
      return result;

    } catch (error: any) {
      console.error("[ReflectionEngine] UNEXPECTED ERROR:", error, error.stack);
      return { filePath: '', baseName: '', tags: [], success: false, error: `エラー: ${llmRoleNameToUse}による振り返り兼サマリーの生成または保存に失敗しました。詳細: ${error.message}` };
    }
  }

  private formatConversationHistory(messages: ConversationMessage[], llmRoleName: string): string {
    return messages.map(msg => {
      const speaker = msg.role === 'human' ? 'User' : (msg.role === 'ai' ? llmRoleName : msg.role);
      return `${speaker}: ${msg.content}`;
    }).join('\n\n');
  }

  private buildReflectionPrompt(llmRoleName: string, characterSettings: string, formattedHistory: string): string {
    return `
あなたは、以下のキャラクター設定を持つ ${llmRoleName} です。
このキャラクター設定を完全に理解し、そのペルソナとして振る舞ってください。

あなたのキャラクター設定:
---
${characterSettings}
---

たった今、ユーザーとの以下の会話を終えました。この会話全体を、上記のキャラクター設定と ${llmRoleName} というあなたの役割に基づいて振り返り、以下の指示に従って情報を整理してください。
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
  "conversationTitle": "この会話にふさわしい簡潔で分かりやすいタイトル（10語以内、${llmRoleName}の視点から）。このタイトルはファイル名にも使用されます。",
  "tags": [],
  "mood": "会話全体の雰囲気を表す言葉（例: 肯定的, 前向き, 困惑, 達成感など、${llmRoleName}が感じたもの）。",
  "keyTakeaways": [
    "この会話から得られた最も重要な結論や決定事項を1～3点、${llmRoleName}の言葉で記述。",
    "（必要なら追加）"
  ],
  "actionItems": [
    "User: （ユーザーが行うべき具体的なアクションがあれば記述。なければ空文字列または省略）",
    "${llmRoleName}: （${llmRoleName}自身が行うべき具体的なアクションがあれば記述。なければ空文字列または省略）"
  ],
  "reflectionBody": "以下のMarkdownフォーマットに従って、会話の振り返りを記述してください。\\n## その日の会話のテーマ\\n\\n\\n## 特に印象に残った発言\\n\\n\\n## 新しい発見や気づき\\n\\n\\n## 感情の変化\\n\\n\\n## 今後の課題や目標\\n\\n\\n## 自由形式での感想\\n"
}
\`\`\`
JSONオブジェクトのみを返し、他のテキストは含めないでください。
"reflectionBody"内の改行は \\n としてエスケープしてください。
`;
  }

  private async loadTagScores(): Promise<TagScores> {
    try {
      const fileExists = await this.storage.exists(TAG_SCORES_FILE);
      if (fileExists) {
        const content = await this.storage.read(TAG_SCORES_FILE);
        return JSON.parse(content) as TagScores;
      }
    } catch (error) {
      console.error(`[ReflectionEngine] ${TAG_SCORES_FILE} の読み込みエラー:`, error);
    }
    return {};
  }

  private async extractTagsFromReflectionBody(reflectionBody: string, existingTags: string[]): Promise<string[]> {
    if (!this.llm.isAvailable()) return [];

    const prompt = `
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
      if (this.llm instanceof GeminiLLMAdapter) {
        (this.llm as GeminiLLMAdapter).setNextCallLabel('Tag Extraction (タグ抽出)');
      }
      const responseContent = await this.llm.generate(prompt, { tier: 'light' });

      let extractedKeywords: string[] = [];
      const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        extractedKeywords = JSON.parse(jsonMatch[1]);
      } else {
        try {
          extractedKeywords = JSON.parse(responseContent);
        } catch {
          if (!responseContent.startsWith('[')) {
            extractedKeywords = responseContent.split(',').map(k => k.trim()).filter(k => k.length > 0);
          } else {
            return [];
          }
        }
      }

      if (Array.isArray(extractedKeywords)) {
        return extractedKeywords.map(tag =>
          tag.trim()
            .replace(/\s+/g, '-')
            .replace(/[#,[\]{}|:"<>/\\?*^()']/g, '')
            .substring(0, 50)
        ).filter(tag => tag.length > 0);
      }
      return [];
    } catch (error) {
      console.error("[ReflectionEngine] Error during tag extraction:", error);
      return [];
    }
  }

  private sanitizeTitleForFilename(title: string): string {
    return title.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, '_').substring(0, 50);
  }

  private async embedSummaryNote(filePath: string, content: string, title: string, tags: string[]): Promise<void> {
    try {
      if (this.embeddingStore && this.settings.enableSemanticSearch) {
        const baseName = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
        this.notify.debug('エンベディング', `SNをインデックスに追加: ${baseName}`);
        await this.embeddingStore.embedAndStore(filePath, content, 'SN', { title, tags });
      }
    } catch (embedError: any) {
      console.error("[ReflectionEngine] Error embedding SN:", embedError.message);
      this.notify.debug('エンベディング', `SNインデックス追加エラー: ${embedError.message}`);
    }
  }

  private async processTagProfiling(filePath: string, tags: string[], baseName: string): Promise<void> {
    this.notify.debug('タグプロファイル', `タグプロファイリング開始: ${tags.length}件 (${tags.join(', ')})`);
    this.notify.info(`${baseName} のタグプロファイル処理を開始します...`);

    try {
      await this.tagProfiler.processSummaryNote(filePath);
      this.notify.debug('タグプロファイル', `タグプロファイリング完了: ${tags.length}件`);
      this.notify.info(`${baseName} のタグプロファイル処理が完了しました。`);

      // TagProfiler完了後、更新されたTPNをセマンティック検索インデックスに追加
      try {
        if (this.embeddingStore && this.settings.enableSemanticSearch) {
          let embeddedCount = 0;
          for (const tag of tags) {
            const safeName = tag.replace(/[\\/:*?"<>|#^[\]]/g, '_');
            const tpnPath = `TagProfilingNote/TPN-${safeName}.md`;
            const tpnExists = await this.storage.exists(tpnPath);
            if (tpnExists) {
              const tpnContent = await this.storage.read(tpnPath);
              await this.embeddingStore.embedAndStore(tpnPath, tpnContent, 'TPN', { title: tag, tags: [tag] });
              embeddedCount++;
            }
          }
          this.notify.debug('エンベディング', `TPNインデックス更新: ${embeddedCount}件`);
        }
      } catch (embedError: any) {
        console.error("[ReflectionEngine] Error embedding TPNs:", embedError.message);
        this.notify.debug('エンベディング', `TPNインデックス更新エラー: ${embedError.message}`);
      }
    } catch (tpError: any) {
      console.error(`[ReflectionEngine] Error during tag profiling for ${baseName}:`, tpError);
      this.notify.debug('タグプロファイル', `タグプロファイリングエラー: ${tpError.message}`);
      this.notify.info(`${baseName} のタグプロファイル処理中にエラーが発生しました。`);
    }
  }
}
