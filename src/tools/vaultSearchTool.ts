// src/tools/vaultSearchTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { App, TFile, CachedMetadata } from 'obsidian';
import ObsidianMemoria from "../../main";
import { z } from "zod";

const VaultSearchToolInputSchema = z.object({
    action: z.enum(["search", "search_by_tag", "fulltext", "read", "list_tags"])
        .describe("Action to perform. 'search': find notes by filename keyword. 'search_by_tag': find notes with a specific tag. 'fulltext': search within note contents. 'read': read a specific note. 'list_tags': list all tags in the vault."),
    query: z.string().optional()
        .describe("For 'search'/'fulltext': keyword to search for. For 'search_by_tag': tag name (with or without #). For 'read': filename or path. Not needed for 'list_tags'."),
    max_results: z.number().optional()
        .describe("Maximum number of search results to return. Default is 10."),
}).describe("Input for searching and reading notes in the Obsidian vault.");

export type VaultSearchToolInput = z.infer<typeof VaultSearchToolInputSchema>;

export class VaultSearchTool extends StructuredTool<typeof VaultSearchToolInputSchema> {
    schema = VaultSearchToolInputSchema;

    name = "vault_search";
    description = `Searches and reads notes in the Obsidian vault.
Available actions:
- "search": Find notes by filename keyword. Parameters: {"query": "keyword", "max_results"?: 10}.
- "search_by_tag": Find notes that have a specific tag. Parameters: {"query": "tag-name", "max_results"?: 10}.
- "fulltext": Search within note contents for a keyword or phrase. Parameters: {"query": "search text", "max_results"?: 10}. Returns matching notes with surrounding context snippets.
- "read": Read the full content of a specific note. Parameters: {"query": "filename or path"}.
- "list_tags": List all tags used in the vault with their counts. No query needed.

Use this tool when you want to look up information, find related notes, explore tags, or read specific documents in the vault.`;

    private app: App;
    private plugin: ObsidianMemoria;

    constructor(plugin: ObsidianMemoria) {
        super();
        this.plugin = plugin;
        this.app = plugin.app;
    }

    protected async _call(input: VaultSearchToolInput): Promise<string> {
        try {
            const maxResults = input.max_results || 10;
            switch (input.action) {
                case "search":
                    return await this.searchByFilename(input.query || '', maxResults);
                case "search_by_tag":
                    return await this.searchByTag(input.query || '', maxResults);
                case "fulltext":
                    return await this.fulltextSearch(input.query || '', maxResults);
                case "read":
                    return await this.readNote(input.query || '');
                case "list_tags":
                    return this.listTags(maxResults);
                default:
                    return JSON.stringify({ success: false, message: `Unknown action: ${input.action}` });
            }
        } catch (error: any) {
            return JSON.stringify({ success: false, message: `Error: ${error.message}` });
        }
    }

    private async searchByFilename(query: string, maxResults: number): Promise<string> {
        if (!query) return JSON.stringify({ success: false, message: "検索キーワードが指定されていません。" });

        const files = this.app.vault.getMarkdownFiles();
        const queryLower = query.toLowerCase();

        const results: Array<{ path: string; name: string; snippet: string }> = [];

        for (const file of files) {
            if (file.basename.toLowerCase().includes(queryLower)) {
                const content = await this.app.vault.cachedRead(file);
                results.push({
                    path: file.path,
                    name: file.basename,
                    snippet: this.getHeadSnippet(content),
                });
            }
            if (results.length >= maxResults) break;
        }

        return JSON.stringify({
            success: true,
            message: results.length > 0
                ? `${results.length}件のノートが見つかりました。`
                : `「${query}」に一致するノートは見つかりませんでした。`,
            results,
        });
    }

    private searchByTag(query: string, maxResults: number): string {
        if (!query) return JSON.stringify({ success: false, message: "タグが指定されていません。" });

        // # を正規化
        const tagName = query.startsWith('#') ? query : `#${query}`;
        const tagLower = tagName.toLowerCase();

        const files = this.app.vault.getMarkdownFiles();
        const results: Array<{ path: string; name: string; tags: string[] }> = [];

        for (const file of files) {
            const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
            if (!cache) continue;

            const fileTags: string[] = [];

            // frontmatter tags
            if (cache.frontmatter?.tags) {
                const fmTags = Array.isArray(cache.frontmatter.tags)
                    ? cache.frontmatter.tags
                    : [cache.frontmatter.tags];
                fileTags.push(...fmTags.map((t: string) => t.startsWith('#') ? t : `#${t}`));
            }

            // inline tags
            if (cache.tags) {
                fileTags.push(...cache.tags.map(t => t.tag));
            }

            if (fileTags.some(t => t.toLowerCase() === tagLower || t.toLowerCase().startsWith(tagLower + '/'))) {
                results.push({
                    path: file.path,
                    name: file.basename,
                    tags: fileTags,
                });
            }
            if (results.length >= maxResults) break;
        }

        return JSON.stringify({
            success: true,
            message: results.length > 0
                ? `タグ「${tagName}」を持つノートが${results.length}件見つかりました。`
                : `タグ「${tagName}」を持つノートは見つかりませんでした。`,
            results,
        });
    }

    private async fulltextSearch(query: string, maxResults: number): Promise<string> {
        if (!query) return JSON.stringify({ success: false, message: "検索キーワードが指定されていません。" });

        const files = this.app.vault.getMarkdownFiles();
        const queryLower = query.toLowerCase();

        const results: Array<{ path: string; name: string; matchCount: number; snippets: string[] }> = [];

        for (const file of files) {
            const content = await this.app.vault.cachedRead(file);
            const contentLower = content.toLowerCase();

            if (!contentLower.includes(queryLower)) continue;

            // マッチ数をカウント
            let matchCount = 0;
            let searchPos = 0;
            while ((searchPos = contentLower.indexOf(queryLower, searchPos)) !== -1) {
                matchCount++;
                searchPos += queryLower.length;
            }

            // 最初の数件のスニペットを抽出
            const snippets = this.extractMultipleSnippets(content, query, 3);

            results.push({
                path: file.path,
                name: file.basename,
                matchCount,
                snippets,
            });

            if (results.length >= maxResults) break;
        }

        // マッチ数で降順ソート
        results.sort((a, b) => b.matchCount - a.matchCount);

        return JSON.stringify({
            success: true,
            message: results.length > 0
                ? `${results.length}件のノートで「${query}」が見つかりました。`
                : `「${query}」を含むノートは見つかりませんでした。`,
            results,
        });
    }

    private async readNote(query: string): Promise<string> {
        if (!query) return JSON.stringify({ success: false, message: "ファイル名が指定されていません。" });

        let file: TFile | null = null;

        // 正確なパスで探す
        const normalizedQuery = query.endsWith('.md') ? query : `${query}.md`;
        const abstractFile = this.app.vault.getAbstractFileByPath(normalizedQuery);
        if (abstractFile instanceof TFile) {
            file = abstractFile;
        }

        // ファイル名で完全一致
        if (!file) {
            const queryLower = query.toLowerCase().replace(/\.md$/, '');
            const allFiles = this.app.vault.getMarkdownFiles();
            file = allFiles.find(f => f.basename.toLowerCase() === queryLower) || null;
        }

        // 部分一致
        if (!file) {
            const queryLower = query.toLowerCase().replace(/\.md$/, '');
            const allFiles = this.app.vault.getMarkdownFiles();
            file = allFiles.find(f => f.basename.toLowerCase().includes(queryLower)) || null;
        }

        if (!file) {
            return JSON.stringify({
                success: false,
                message: `「${query}」に一致するノートが見つかりませんでした。`,
            });
        }

        const content = await this.app.vault.cachedRead(file);

        // タグ情報も取得
        const cache = this.app.metadataCache.getFileCache(file);
        const tags: string[] = [];
        if (cache?.frontmatter?.tags) {
            const fmTags = Array.isArray(cache.frontmatter.tags)
                ? cache.frontmatter.tags
                : [cache.frontmatter.tags];
            tags.push(...fmTags);
        }
        if (cache?.tags) {
            tags.push(...cache.tags.map(t => t.tag));
        }

        const maxLength = 3000;
        const truncated = content.length > maxLength;
        const displayContent = truncated
            ? content.substring(0, maxLength) + "\n\n... (以下省略)"
            : content;

        return JSON.stringify({
            success: true,
            path: file.path,
            name: file.basename,
            tags: [...new Set(tags)],
            truncated,
            content: displayContent,
        });
    }

    private listTags(maxResults: number): string {
        const tagCounts: Record<string, number> = {};
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
            if (!cache) continue;

            if (cache.frontmatter?.tags) {
                const fmTags = Array.isArray(cache.frontmatter.tags)
                    ? cache.frontmatter.tags
                    : [cache.frontmatter.tags];
                for (const tag of fmTags) {
                    const normalized = tag.startsWith('#') ? tag : `#${tag}`;
                    tagCounts[normalized] = (tagCounts[normalized] || 0) + 1;
                }
            }

            if (cache.tags) {
                for (const tagRef of cache.tags) {
                    tagCounts[tagRef.tag] = (tagCounts[tagRef.tag] || 0) + 1;
                }
            }
        }

        const sorted = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxResults)
            .map(([tag, count]) => ({ tag, count }));

        return JSON.stringify({
            success: true,
            message: `${sorted.length}件のタグが見つかりました。`,
            tags: sorted,
        });
    }

    private getHeadSnippet(content: string): string {
        // frontmatterを除いた本文の先頭部分
        const bodyMatch = content.match(/^---[\s\S]+?---\s*([\s\S]*)/);
        const body = bodyMatch ? bodyMatch[1] : content;
        return body.substring(0, 150).replace(/\n/g, ' ').trim() + (body.length > 150 ? '...' : '');
    }

    private extractMultipleSnippets(content: string, query: string, maxSnippets: number): string[] {
        const contentLower = content.toLowerCase();
        const queryLower = query.toLowerCase();
        const snippets: string[] = [];
        let searchPos = 0;

        while (snippets.length < maxSnippets) {
            const index = contentLower.indexOf(queryLower, searchPos);
            if (index === -1) break;

            const start = Math.max(0, index - 40);
            const end = Math.min(content.length, index + query.length + 80);
            let snippet = content.substring(start, end).replace(/\n/g, ' ');
            if (start > 0) snippet = '...' + snippet;
            if (end < content.length) snippet = snippet + '...';
            snippets.push(snippet);

            searchPos = index + query.length + 80; // 重複を避けるためスキップ
        }

        return snippets;
    }
}
