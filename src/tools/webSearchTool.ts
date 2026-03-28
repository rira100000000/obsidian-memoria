// src/tools/webSearchTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { requestUrl } from 'obsidian';
import ObsidianMemoria from "../../main";
import { z } from "zod";

const WebFetchToolInputSchema = z.object({
    url: z.string()
        .describe("The URL to fetch and extract text content from."),
}).describe("Input for fetching a web page.");

export type WebFetchToolInput = z.infer<typeof WebFetchToolInputSchema>;

/**
 * Webページのコンテンツをフェッチして読み取るツール。
 * 検索はGeminiのネイティブgoogle_search機能が担当するため、
 * このツールはURLを指定してページの本文テキストを取得する用途に特化する。
 */
export class WebFetchTool extends StructuredTool<typeof WebFetchToolInputSchema> {
    schema = WebFetchToolInputSchema;

    name = "web_fetch";
    description = `Fetches a web page and extracts its text content. Use this when you need to read the full content of a specific URL (e.g., an article, documentation, or blog post found via search). Parameters: {"url": "https://example.com"}.`;

    private plugin: ObsidianMemoria;

    constructor(plugin: ObsidianMemoria) {
        super();
        this.plugin = plugin;
    }

    public onSettingsChanged(): void {}

    protected async _call(input: WebFetchToolInput): Promise<string> {
        const url = input.url;

        // 基本的なURL検証
        try {
            new URL(url);
        } catch {
            return JSON.stringify({ success: false, message: `Invalid URL: ${url}` });
        }

        try {
            const response = await requestUrl({ url });
            const html = response.text;
            const textContent = this.extractTextFromHtml(html);

            // テキストが長すぎる場合は切り詰め
            const maxLength = 5000;
            const truncated = textContent.length > maxLength;
            const content = truncated
                ? textContent.substring(0, maxLength) + "\n... (以下省略)"
                : textContent;

            return JSON.stringify({
                success: true,
                url,
                content,
                truncated,
                originalLength: textContent.length
            });
        } catch (error: any) {
            console.error(`[WebFetchTool] Fetch error:`, error);
            return JSON.stringify({
                success: false,
                message: `Failed to fetch URL: ${error.message}`
            });
        }
    }

    /**
     * HTMLからテキストコンテンツを抽出する。
     */
    private extractTextFromHtml(html: string): string {
        let cleaned = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[\s\S]*?<\/footer>/gi, '')
            .replace(/<aside[\s\S]*?<\/aside>/gi, '')
            .replace(/<header[\s\S]*?<\/header>/gi, '');

        cleaned = cleaned.replace(/<[^>]+>/g, ' ');

        cleaned = cleaned
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));

        cleaned = cleaned
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return cleaned;
    }
}
