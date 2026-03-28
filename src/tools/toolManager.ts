// src/tools/toolManager.ts
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import ObsidianMemoria from "../../main";
import { ConversationReflectionTool } from "./conversationReflectionTool";
import { TodoTool } from "./todoTool";
import { VaultSearchTool } from "./vaultSearchTool";
import { SemanticSearchTool } from "./semanticSearchTool";
import { WebFetchTool } from "./webSearchTool";
// TSchema が ZodObject を拡張することを保証するジェネリック型制約
type AnyZodObject = z.ZodObject<any, any, any, any>;

// Gemini API の google_search ツール型（SDKの型定義が未対応のため独自定義）
type GoogleSearchTool = { google_search: Record<string, never> };

export class ToolManager {
  private plugin: ObsidianMemoria;
  private availableTools: StructuredTool<AnyZodObject>[];
  private toolMap: Map<string, StructuredTool<AnyZodObject>>;
  private nativeTools: GoogleSearchTool[];

  constructor(plugin: ObsidianMemoria) {
    this.plugin = plugin;
    this.availableTools = [];
    this.toolMap = new Map();
    this.nativeTools = [];
    this.initializeTools();
  }

  private initializeTools(): void {
    const conversationReflectionTool = new ConversationReflectionTool(this.plugin);
    const todoTool = new TodoTool(this.plugin);
    const vaultSearchTool = new VaultSearchTool(this.plugin);

    this.registerTool(conversationReflectionTool);
    this.registerTool(todoTool);
    this.registerTool(vaultSearchTool);

    if (this.plugin.settings.enableWebSearch) {
      // Geminiネイティブのgoogle_searchツール
      this.nativeTools.push({ google_search: {} });
      // URLフェッチ用ツール
      const webFetchTool = new WebFetchTool(this.plugin);
      this.registerTool(webFetchTool);
      console.log('[ToolManager] Web search enabled: Google Search grounding + WebFetchTool registered.');
    }

    if (this.plugin.settings.enableSemanticSearch) {
      const semanticSearchTool = new SemanticSearchTool(this.plugin);
      this.registerTool(semanticSearchTool);
    }
  }

  public registerTool(tool: StructuredTool<AnyZodObject>): void {
    if (!tool.name || typeof tool.name !== 'string' || tool.name.trim() === '') {
        console.error("[ToolManager] Attempted to register a tool with an invalid name:", tool);
        return;
    }
    if (this.toolMap.has(tool.name)) {
        console.warn(`[ToolManager] Tool with name "${tool.name}" is already registered. Overwriting.`);
    }
    this.availableTools.push(tool);
    this.toolMap.set(tool.name, tool);
    console.log(`[ToolManager] Registered tool: ${tool.name}`);
  }

  public getToolByName(name: string): StructuredTool<AnyZodObject> | undefined {
    return this.toolMap.get(name);
  }

  /**
   * LangchainのLLMに渡すためのツールのリストを返します。
   * StructuredTool と Geminiネイティブツール(google_search等)の両方を含みます。
   */
  public getLangchainTools(): (StructuredTool<AnyZodObject> | GoogleSearchTool)[] {
    return [...this.availableTools, ...this.nativeTools];
  }

  public onSettingsChanged(): void {
    // ツールリストをクリアして再登録（設定変更でツールの有効/無効が変わるため）
    this.availableTools = [];
    this.toolMap.clear();
    this.nativeTools = [];
    this.initializeTools();
    console.log(`[ToolManager] Settings changed, tools re-initialized. Active tools: ${this.availableTools.map(t => t.name).join(', ')}${this.nativeTools.length > 0 ? ' + Google Search grounding' : ''}`);
  }
}
