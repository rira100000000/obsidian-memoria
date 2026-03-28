// src/embeddingStore.ts
import { App, TFile, Notice, parseYaml } from 'obsidian';
import { GoogleGenerativeAI } from "@google/generative-ai";
import ObsidianMemoria from '../main';
import { GeminiPluginSettings } from './settings';
import { EmbeddingEntry, EmbeddingIndex } from './types';

const EMBEDDING_INDEX_FILE = 'embedding_index.json';
const TPN_DIR = 'TagProfilingNote';
const SN_DIR = 'SummaryNote';
const EMBEDDING_MODEL = 'gemini-embedding-001';

export class EmbeddingStore {
  private app: App;
  private plugin: ObsidianMemoria;
  private settings: GeminiPluginSettings;
  private genAI: GoogleGenerativeAI | null = null;
  private index: EmbeddingIndex;

  constructor(plugin: ObsidianMemoria) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.settings = plugin.settings;
    this.index = { version: 1, model: EMBEDDING_MODEL, entries: {} };
    this.initializeClient();
  }

  private initializeClient(): void {
    if (!this.settings.geminiApiKey) {
      console.warn("[EmbeddingStore] API key not set. Client not initialized.");
      this.genAI = null;
      return;
    }
    try {
      this.genAI = new GoogleGenerativeAI(this.settings.geminiApiKey);
      console.log(`[EmbeddingStore] Client initialized for model: ${EMBEDDING_MODEL}`);
    } catch (e: any) {
      console.error("[EmbeddingStore] Failed to initialize client:", e.message);
      this.genAI = null;
    }
  }

  private async callEmbedAPI(text: string): Promise<number[]> {
    if (!this.genAI) throw new Error("Embedding client not initialized");

    const model = this.genAI.getGenerativeModel(
      { model: EMBEDDING_MODEL },
      { apiVersion: "v1beta" }
    );
    const result = await model.embedContent(text);
    return result.embedding.values;
  }

  public async initialize(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const exists = await this.app.vault.adapter.exists(EMBEDDING_INDEX_FILE);
      if (exists) {
        const content = await this.app.vault.adapter.read(EMBEDDING_INDEX_FILE);
        const parsed = JSON.parse(content) as EmbeddingIndex;
        if (parsed.model === EMBEDDING_MODEL) {
          this.index = parsed;
          console.log(`[EmbeddingStore] Loaded index with ${Object.keys(this.index.entries).length} entries.`);
        } else {
          console.log(`[EmbeddingStore] Model mismatch (${parsed.model} vs ${EMBEDDING_MODEL}). Starting fresh index.`);
          this.index = { version: 1, model: EMBEDDING_MODEL, entries: {} };
        }
      }
    } catch (e: any) {
      console.error("[EmbeddingStore] Error loading index:", e.message);
      this.index = { version: 1, model: EMBEDDING_MODEL, entries: {} };
    }
  }

  public async save(): Promise<void> {
    try {
      const content = JSON.stringify(this.index, null, 2);
      await this.app.vault.adapter.write(EMBEDDING_INDEX_FILE, content);
      console.log(`[EmbeddingStore] Index saved with ${Object.keys(this.index.entries).length} entries.`);
    } catch (e: any) {
      console.error("[EmbeddingStore] Error saving index:", e.message);
    }
  }

  private computeContentHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  public async embedAndStore(
    filePath: string,
    content: string,
    sourceType: 'TPN' | 'SN',
    metadata?: { title?: string; tags?: string[] }
  ): Promise<boolean> {
    if (!this.genAI || !this.settings.enableSemanticSearch) {
      return false;
    }

    const contentHash = this.computeContentHash(content);
    const existing = this.index.entries[filePath];
    if (existing && existing.contentHash === contentHash) {
      console.log(`[EmbeddingStore] Content unchanged for ${filePath}, skipping embed.`);
      return true;
    }

    try {
      const embedding = await this.callEmbedAPI(content);
      this.index.entries[filePath] = {
        filePath,
        sourceType,
        contentHash,
        embedding,
        title: metadata?.title,
        tags: metadata?.tags,
        updatedAt: new Date().toISOString(),
      };
      await this.save();
      console.log(`[EmbeddingStore] Embedded and stored: ${filePath}`);
      return true;
    } catch (e: any) {
      console.error(`[EmbeddingStore] Error embedding ${filePath}:`, e.message);
      return false;
    }
  }

  public async embedQuery(text: string): Promise<number[] | null> {
    if (!this.genAI) {
      console.warn("[EmbeddingStore] Client not initialized for query.");
      return null;
    }
    try {
      return await this.callEmbedAPI(text);
    } catch (e: any) {
      console.error("[EmbeddingStore] Error embedding query:", e.message);
      return null;
    }
  }

  public findSimilar(
    queryEmbedding: number[],
    topK: number,
    minSimilarity: number,
    sourceTypeFilter?: 'TPN' | 'SN' | 'all'
  ): Array<{ entry: EmbeddingEntry; similarity: number }> {
    const results: Array<{ entry: EmbeddingEntry; similarity: number }> = [];

    for (const entry of Object.values(this.index.entries)) {
      if (sourceTypeFilter && sourceTypeFilter !== 'all' && entry.sourceType !== sourceTypeFilter) {
        continue;
      }
      const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity >= minSimilarity) {
        results.push({ entry, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }

  public async rebuildIndex(): Promise<number> {
    if (!this.genAI) {
      new Notice("Embedding APIが初期化されていません。APIキーを確認してください。");
      return 0;
    }

    console.log("[EmbeddingStore] Starting full index rebuild...");
    new Notice("セマンティック検索インデックスの再構築を開始します...");
    this.index.entries = {};

    const filesToEmbed: Array<{ file: TFile; sourceType: 'TPN' | 'SN' }> = [];

    const tpnFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(TPN_DIR + '/'));
    for (const file of tpnFiles) {
      filesToEmbed.push({ file, sourceType: 'TPN' });
    }

    const snFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(SN_DIR + '/'));
    for (const file of snFiles) {
      filesToEmbed.push({ file, sourceType: 'SN' });
    }

    console.log(`[EmbeddingStore] Found ${filesToEmbed.length} files to embed (${tpnFiles.length} TPN, ${snFiles.length} SN).`);

    let embedded = 0;
    let errorCount = 0;

    for (let i = 0; i < filesToEmbed.length; i++) {
      const { file, sourceType } = filesToEmbed[i];
      const success = await (async () => {
        try {
          const content = await this.app.vault.cachedRead(file);
          const frontmatter = this.parseFrontmatter(content);
          const bodyContent = this.extractBody(content);
          if (!bodyContent || bodyContent.trim().length === 0) {
            console.warn(`[EmbeddingStore] Empty body for ${file.path}, skipping.`);
            return false;
          }

          const textToEmbed = this.prepareTextForEmbedding(bodyContent, frontmatter, sourceType);
          console.log(`[EmbeddingStore] Embedding ${file.path} (${textToEmbed.length} chars)...`);
          const embedding = await this.callEmbedAPI(textToEmbed);
          const contentHash = this.computeContentHash(textToEmbed);

          this.index.entries[file.path] = {
            filePath: file.path,
            sourceType,
            contentHash,
            embedding,
            title: frontmatter?.title || frontmatter?.tag_name || file.basename,
            tags: frontmatter?.tags || (frontmatter?.tag_name ? [frontmatter.tag_name] : []),
            updatedAt: new Date().toISOString(),
          };
          return true;
        } catch (e: any) {
          console.error(`[EmbeddingStore] Error embedding ${file.path}:`, e.message, e.stack);
          new Notice(`Embedding失敗: ${file.basename} - ${e.message}`);
          return false;
        }
      })();
      if (success) {
        embedded++;
      } else {
        errorCount++;
      }
      if ((i + 1) % 5 === 0 || i === filesToEmbed.length - 1) {
        new Notice(`インデックス構築中... ${i + 1}/${filesToEmbed.length} 件処理済み (成功: ${embedded}, 失敗: ${errorCount})`);
      }
    }

    await this.save();
    const msg = `セマンティック検索インデックスの再構築が完了しました。${embedded}/${filesToEmbed.length}件をインデックスしました。`;
    console.log(`[EmbeddingStore] ${msg}`);
    new Notice(msg);
    return embedded;
  }

  public removeEntry(filePath: string): void {
    if (this.index.entries[filePath]) {
      delete this.index.entries[filePath];
      console.log(`[EmbeddingStore] Removed entry: ${filePath}`);
    }
  }

  public onSettingsChanged(): void {
    this.settings = this.plugin.settings;
    this.initializeClient();
    console.log('[EmbeddingStore] Settings changed, client re-initialized.');
  }

  public getEntryCount(): number {
    return Object.keys(this.index.entries).length;
  }

  private parseFrontmatter(content: string): Record<string, any> | null {
    try {
      const match = content.match(/^---([\s\S]+?)---/);
      if (match && match[1]) {
        return parseYaml(match[1]);
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractBody(content: string): string {
    const match = content.match(/^---[\s\S]+?---\s*([\s\S]*)/);
    return match ? match[1].trim() : content.trim();
  }

  private prepareTextForEmbedding(body: string, frontmatter: Record<string, any> | null, sourceType: 'TPN' | 'SN'): string {
    let text = '';
    if (frontmatter) {
      if (frontmatter.title) text += `タイトル: ${frontmatter.title}\n`;
      if (frontmatter.tag_name) text += `タグ: ${frontmatter.tag_name}\n`;
      if (frontmatter.key_themes) text += `テーマ: ${(frontmatter.key_themes as string[]).join(', ')}\n`;
      if (frontmatter.key_takeaways) text += `ポイント: ${(frontmatter.key_takeaways as string[]).join(', ')}\n`;
      if (frontmatter.tags) text += `タグ: ${(frontmatter.tags as string[]).join(', ')}\n`;
    }
    const maxBodyLength = 4000;
    const truncatedBody = body.length > maxBodyLength ? body.substring(0, maxBodyLength) : body;
    text += truncatedBody;
    return text;
  }
}
