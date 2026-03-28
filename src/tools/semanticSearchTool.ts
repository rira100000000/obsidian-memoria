// src/tools/semanticSearchTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { App, TFile } from 'obsidian';
import ObsidianMemoria from "../../main";
import { z } from "zod";

const SemanticSearchToolInputSchema = z.object({
    query: z.string().describe("検索したい内容を自然言語で記述"),
    max_results: z.number().optional().describe("最大結果数。デフォルト5"),
    source_type: z.enum(["all", "SN", "TPN"]).optional().describe("検索対象。デフォルトall"),
}).describe("Input for semantic search over memory notes.");

export type SemanticSearchToolInput = z.infer<typeof SemanticSearchToolInputSchema>;

export class SemanticSearchTool extends StructuredTool<typeof SemanticSearchToolInputSchema> {
    schema = SemanticSearchToolInputSchema;

    name = "semantic_search";
    description = `意味的に類似したノートを検索する。キーワード一致ではなく意味の近さで検索。
SummaryNote（会話の要約）やTagProfilingNote（タグのプロファイル）から、クエリと意味的に関連するものを見つける。
記憶の中から関連する情報を探したいときに使う。`;

    private app: App;
    private plugin: ObsidianMemoria;

    constructor(plugin: ObsidianMemoria) {
        super();
        this.plugin = plugin;
        this.app = plugin.app;
    }

    protected async _call(input: SemanticSearchToolInput): Promise<string> {
        const embeddingStore = this.plugin.embeddingStore;
        if (!embeddingStore) {
            return JSON.stringify({ success: false, message: "セマンティック検索が初期化されていません。" });
        }
        if (!this.plugin.settings.enableSemanticSearch) {
            return JSON.stringify({ success: false, message: "セマンティック検索が無効になっています。設定で有効にしてください。" });
        }

        const maxResults = input.max_results || this.plugin.settings.semanticSearchTopK || 5;
        const sourceType = input.source_type || 'all';

        try {
            const queryEmbedding = await embeddingStore.embedQuery(input.query);
            if (!queryEmbedding) {
                return JSON.stringify({ success: false, message: "クエリのembeddingに失敗しました。" });
            }

            const results = embeddingStore.findSimilar(
                queryEmbedding,
                maxResults,
                this.plugin.settings.semanticSearchMinSimilarity || 0.3,
                sourceType === 'all' ? undefined : sourceType
            );

            if (results.length === 0) {
                return JSON.stringify({
                    success: true,
                    message: `「${input.query}」に意味的に類似するノートは見つかりませんでした。`,
                    results: [],
                });
            }

            const formattedResults = await Promise.all(results.map(async ({ entry, similarity }) => {
                let snippet = '';
                try {
                    const file = this.app.vault.getAbstractFileByPath(entry.filePath);
                    if (file instanceof TFile) {
                        const content = await this.app.vault.cachedRead(file);
                        snippet = this.extractSnippet(content);
                    }
                } catch {
                    snippet = '(内容の読み込みに失敗)';
                }

                return {
                    title: entry.title || entry.filePath,
                    path: entry.filePath,
                    sourceType: entry.sourceType,
                    similarity: Math.round(similarity * 1000) / 1000,
                    tags: entry.tags || [],
                    snippet,
                };
            }));

            return JSON.stringify({
                success: true,
                message: `${formattedResults.length}件の類似ノートが見つかりました。`,
                results: formattedResults,
            });
        } catch (e: any) {
            console.error("[SemanticSearchTool] Error:", e.message);
            return JSON.stringify({ success: false, message: `エラー: ${e.message}` });
        }
    }

    private extractSnippet(content: string): string {
        // Extract body after frontmatter
        const bodyMatch = content.match(/^---[\s\S]+?---\s*([\s\S]*)/);
        const body = bodyMatch ? bodyMatch[1] : content;
        // Return first 300 chars as snippet
        const snippet = body.substring(0, 300).replace(/\n/g, ' ').trim();
        return snippet.length < body.length ? snippet + '...' : snippet;
    }
}
