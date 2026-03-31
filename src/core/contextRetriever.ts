// src/core/contextRetriever.ts
import { parse as parseYaml } from 'yaml';
import { StorageAdapter } from './interfaces/storageAdapter';
import { GeminiPluginSettings } from '../settings';
import { TagProfilingNoteFrontmatter, SummaryNoteFrontmatter, RetrievedContextItem, RetrievedContext, ProcessingCallbacks } from './types';
import { EmbeddingStore } from './embeddingStore';

const TPN_DIR = 'TagProfilingNote';
const SN_DIR = 'SummaryNote';

/** "YYYY-MM-DD HH:mm:ss" 形式の文字列をDateに変換 */
function parseDateStr(dateStr: string): Date | null {
  // "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD HH:MM"
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, y, m, d, h, min, s] = match;
  const date = new Date(+y, +m - 1, +d, +h, +min, +(s || 0));
  return isNaN(date.getTime()) ? null : date;
}

/** Date を "YYYY-MM-DD HH:MM" 形式にフォーマット */
function formatDateShort(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Export interfaces used by other modules
export type { RetrievedContextItem, RetrievedContext };

export class ContextRetriever {
  private storage: StorageAdapter;
  private settings: GeminiPluginSettings;
  private embeddingStore: EmbeddingStore | null = null;

  constructor(storage: StorageAdapter, settings: GeminiPluginSettings, embeddingStore?: EmbeddingStore | null) {
    this.storage = storage;
    this.settings = settings;
    this.embeddingStore = embeddingStore || null;
  }

  public onSettingsChanged(settings: GeminiPluginSettings, embeddingStore?: EmbeddingStore | null) {
    this.settings = settings;
    if (embeddingStore !== undefined) {
      this.embeddingStore = embeddingStore || null;
    }
    console.log('[ContextRetriever] Settings changed.');
  }

  public async retrieveContextForPrompt(userPrompt: string, llmRoleName: string, chatHistory: any[], callbacks?: ProcessingCallbacks): Promise<RetrievedContext> {
    const result: RetrievedContext = {
      originalPrompt: userPrompt,
      retrievedItems: [],
      llmContextPrompt: "記憶からの関連情報は見つかりませんでした。",
    };

    if (!this.embeddingStore) {
      callbacks?.onDebugLog?.('記憶検索', 'EmbeddingStoreが未初期化。記憶検索をスキップ');
      return result;
    }

    // Step 1: セマンティック検索（Embedding API 1回のみ）
    callbacks?.onProgress?.('記憶を検索しています...');
    callbacks?.onDebugLog?.('記憶検索', 'セマンティック検索を開始');

    const semanticItems = await this.semanticSearch(userPrompt);
    callbacks?.onDebugLog?.('記憶検索', `セマンティック検索結果: ${semanticItems.length}件 (TPN: ${semanticItems.filter(i => i.sourceType === 'TPN').length}, SN: ${semanticItems.filter(i => i.sourceType === 'SN').length})`);

    if (semanticItems.length === 0) {
      callbacks?.onDebugLog?.('記憶検索', '関連する記憶が見つかりませんでした');
      return result;
    }

    // Step 2: TPN/SN結果を分離
    const tpnItems = semanticItems.filter(i => i.sourceType === 'TPN');
    const snItemsFromSearch = semanticItems.filter(i => i.sourceType === 'SN');

    // Step 3: TPNのfrontmatterからSNリンクを機械的に取得（並列実行）
    callbacks?.onProgress?.('関連ノートを取得しています...');
    const snNamesFromTpns = await this.extractSnLinksFromTpns(tpnItems);

    // 既に取得済みのSNを除外
    const existingSnNames = new Set(snItemsFromSearch.map(i => i.sourceName));
    const newSnNames = snNamesFromTpns.filter(name => !existingSnNames.has(name));

    if (newSnNames.length > 0) {
      callbacks?.onDebugLog?.('追加読み込み', `TPNから関連SN ${newSnNames.length}件を追加取得: ${newSnNames.join(', ')}`);
    }

    // Step 4: 追加SNを取得（並列）
    const additionalSnItems = newSnNames.length > 0 ? await this.fetchSnItems(newSnNames) : [];

    // Step 5: 全結果を統合・重複排除
    const allItems = this.deduplicateItems([...tpnItems, ...snItemsFromSearch, ...additionalSnItems]);
    result.retrievedItems = allItems;
    callbacks?.onDebugLog?.('記憶検索', `最終コンテキスト: ${allItems.length}件`);

    // Step 6: 最終LLM用にフォーマット
    if (allItems.length > 0) {
      result.llmContextPrompt = this.formatContextForFinalLlm(allItems, userPrompt);
    }

    return result;
  }

  // --- Semantic Search ---

  private async semanticSearch(userPrompt: string): Promise<RetrievedContextItem[]> {
    if (!this.embeddingStore) return [];

    try {
      const queryEmbedding = await this.embeddingStore.embedQuery(userPrompt);
      if (!queryEmbedding) return [];

      const topK = this.settings.semanticSearchTopK || 5;
      const minSimilarity = this.settings.semanticSearchMinSimilarity || 0.3;
      const results = this.embeddingStore.findSimilar(queryEmbedding, topK, minSimilarity);

      // TPN/SNの詳細取得を並列実行
      const itemPromises = results.map(async ({ entry, similarity }) => {
        if (entry.sourceType === 'TPN') {
          return this.fetchTpnItemFromSemantic(entry.filePath, similarity);
        } else if (entry.sourceType === 'SN') {
          return this.fetchSnItemFromSemantic(entry.filePath, similarity);
        }
        return null;
      });

      const itemArrays = await Promise.all(itemPromises);
      const items = itemArrays.filter(Boolean) as RetrievedContextItem[];
      console.log(`[ContextRetriever] Semantic search found ${items.length} items.`);
      return items;
    } catch (e: any) {
      console.error("[ContextRetriever] Error in semantic search:", e.message);
      return [];
    }
  }

  // --- TPN Frontmatter → SN Links ---

  private async extractSnLinksFromTpns(tpnItems: RetrievedContextItem[]): Promise<string[]> {
    const MAX_SNS_PER_TPN = 5;

    // 並列でTPN内容を読み取り
    const linkArrays = await Promise.all(tpnItems.map(async (item) => {
      const filePath = `${TPN_DIR}/${item.sourceName}.md`;
      const content = await this.getFileContent(filePath);
      if (!content) return [];
      const frontmatter = this.parseFrontmatter(content) as TagProfilingNoteFrontmatter | null;
      if (!frontmatter?.summary_notes) return [];
      // 最新N件に制限
      return frontmatter.summary_notes.slice(0, MAX_SNS_PER_TPN).map(link => this.cleanFileName(link));
    }));

    const allNames = linkArrays.flat();
    return [...new Set(allNames)];
  }

  // --- Fetch Methods ---

  private async fetchTpnItemFromSemantic(filePath: string, similarity: number): Promise<RetrievedContextItem | null> {
    const fileContent = await this.getFileContent(filePath);
    if (!fileContent) return null;

    const frontmatter = this.parseFrontmatter(fileContent) as TagProfilingNoteFrontmatter | null;
    if (!frontmatter) return null;

    const tagName = frontmatter.tag_name || filePath.replace(/^.*TPN-/, '').replace(/\.md$/, '');
    let snippet = "";
    if (frontmatter.master_significance) snippet += `このタグ「${tagName}」の全体的な重要性: ${frontmatter.master_significance}\n`;
    if (frontmatter.key_themes && frontmatter.key_themes.length > 0) snippet += `関連キーテーマ: ${frontmatter.key_themes.join(', ')}\n`;

    const overviewMatch = fileContent.match(/## 概要\s*([\s\S]*?)(?=\n## |$)/);
    if (overviewMatch && overviewMatch[1]?.trim()) {
      snippet += `\n## 概要\n${overviewMatch[1].trim()}\n`;
    }
    const contextsMatch = fileContent.match(/## これまでの主な文脈\s*([\s\S]*?)(?=\n## |$)/);
    if (contextsMatch && contextsMatch[1]?.trim()) {
      snippet += `\n## これまでの主な文脈\n${contextsMatch[1].trim()}\n`;
    }
    const opinionsMatch = fileContent.match(/## ユーザーの意見・反応\s*([\s\S]*?)(?=\n## |$)/);
    if (opinionsMatch && opinionsMatch[1]?.trim()) {
      snippet += `\n## ユーザーの意見・反応\n${opinionsMatch[1].trim()}\n`;
    }

    const baseName = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
    return {
      sourceType: 'TPN',
      sourceName: baseName,
      title: `タグプロファイル: ${tagName}`,
      date: frontmatter.updated_date || frontmatter.created_date,
      contentSnippet: snippet.trim() || "関連情報なし",
      relevance: similarity * 100,
    };
  }

  private async fetchSnItemFromSemantic(filePath: string, similarity: number): Promise<RetrievedContextItem | null> {
    const fileContent = await this.getFileContent(filePath);
    if (!fileContent) return null;

    const frontmatter = this.parseFrontmatter(fileContent) as SummaryNoteFrontmatter | null;
    if (!frontmatter) return null;

    let snippet = "";
    const summaryMatch = fileContent.match(/## 要約\s*([\s\S]*?)(?=\n## |$)/);
    if (summaryMatch && summaryMatch[1]) {
      snippet += `${summaryMatch[1].trim().substring(0, 500)}...\n`;
    } else {
      const bodyMatch = fileContent.match(/---[\s\S]+?---([\s\S]*)/);
      if (bodyMatch && bodyMatch[1]) {
        snippet += `${bodyMatch[1].trim().split('\n\n')[0].substring(0, 500)}...\n`;
      }
    }
    if (frontmatter.key_takeaways && frontmatter.key_takeaways.length > 0) {
      snippet += `主なポイント: ${frontmatter.key_takeaways.join('; ')}\n`;
    }

    const baseName = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
    return {
      sourceType: 'SN',
      sourceName: baseName,
      title: frontmatter.title,
      date: frontmatter.date ? (parseDateStr(frontmatter.date) ? formatDateShort(parseDateStr(frontmatter.date)!) : undefined) : undefined,
      contentSnippet: snippet.trim() || "関連情報なし",
      relevance: similarity * 100,
    };
  }

  private async fetchSnItems(snFileNames: string[]): Promise<RetrievedContextItem[]> {
    const uniqueSnFileNames = [...new Set(snFileNames.map(name => this.cleanFileName(name)))];
    // 並列でSNを取得
    const results = await Promise.all(uniqueSnFileNames.map(async (snFileName) => {
      const snPath = `${SN_DIR}/${snFileName}.md`;
      const fileContent = await this.getFileContent(snPath);
      if (!fileContent) return null;

      const frontmatter = this.parseFrontmatter(fileContent) as SummaryNoteFrontmatter | null;
      if (!frontmatter) return null;

      let snippet = "";
      const summaryMatch = fileContent.match(/## 要約\s*([\s\S]*?)(?=\n## |$)/);
      if (summaryMatch && summaryMatch[1]) {
        snippet += `${summaryMatch[1].trim().substring(0, 500)}...\n`;
      } else {
        const bodyContentMatch = fileContent.match(/---[\s\S]+?---([\s\S]*)/);
        if (bodyContentMatch && bodyContentMatch[1]) {
          snippet += `${bodyContentMatch[1].trim().split('\n\n')[0].substring(0, 500)}...\n`;
        }
      }
      if (frontmatter.key_takeaways && frontmatter.key_takeaways.length > 0) {
        snippet += `主なポイント: ${frontmatter.key_takeaways.join('; ')}\n`;
      }
      return {
        sourceType: 'SN' as const,
        sourceName: snFileName,
        title: frontmatter.title,
        date: frontmatter.date ? (parseDateStr(frontmatter.date) ? formatDateShort(parseDateStr(frontmatter.date)!) : undefined) : undefined,
        contentSnippet: snippet.trim() || "関連情報なし",
      };
    }));

    return results.filter(Boolean) as RetrievedContextItem[];
  }

  // --- Formatting ---

  /**
   * 日時文字列から現在までの経過時間を人間が読める形式で返す。
   */
  private formatTimeAgo(dateStr: string): string {
    const then = parseDateStr(dateStr);
    if (!then) return '';
    const now = new Date();
    const diffMs = now.getTime() - then.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) return 'たった今';
    if (diffMinutes < 60) return `${diffMinutes}分前`;
    const diffHours = Math.floor(diffMs / 3600000);
    if (diffHours < 24) return `${diffHours}時間前`;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays < 30) return `${diffDays}日前`;
    const diffMonths = Math.floor(diffDays / 30);
    return `${diffMonths}ヶ月前`;
  }

  private formatContextForFinalLlm(items: RetrievedContextItem[], userPrompt: string): string {
    if (items.length === 0) return "記憶からの関連情報は見つかりませんでした。";

    let contextString = "";
    const sortedItems = [...items].sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

    for (const item of sortedItems) {
      const timeAgo = item.date ? this.formatTimeAgo(item.date) : '';
      const timeLabel = timeAgo ? ` [${timeAgo}の会話]` : '';
      contextString += `\n[参照元: ${item.sourceType} - ${item.sourceName} (${item.date || '日付不明'})${timeLabel}]\n`;
      if (item.title) contextString += `タイトル: ${item.title}\n`;
      contextString += `内容抜粋:\n${item.contentSnippet}\n---\n`;
    }

    const maxLength = 1000000;
    if (contextString.length > maxLength) {
      contextString = contextString.substring(0, maxLength) + "... (記憶情報全体を一部省略)...";
    }
    console.log('LLMが読み込むcontext\n' + contextString);
    return contextString;
  }

  // --- Utilities ---

  private deduplicateItems(items: RetrievedContextItem[]): RetrievedContextItem[] {
    const seen = new Map<string, RetrievedContextItem>();
    for (const item of items) {
      const existing = seen.get(item.sourceName);
      if (!existing || (item.relevance || 0) > (existing.relevance || 0)) {
        seen.set(item.sourceName, item);
      }
    }
    return Array.from(seen.values());
  }

  private async getFileContent(filePath: string): Promise<string | null> {
    try {
      const exists = await this.storage.exists(filePath);
      if (!exists) return null;
      return await this.storage.read(filePath);
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
    return fileName.replace(/\[\[|\]\]/g, '').replace(/\.md$/, '');
  }
}
