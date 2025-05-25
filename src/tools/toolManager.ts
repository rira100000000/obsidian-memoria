// src/tools/toolManager.ts
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod"; // z をインポート
import ObsidianMemoria from "../../main";
import { ConversationReflectionTool } from "./conversationReflectionTool";
import { TodoTool } from "./todoTool";

// TSchema が ZodObject を拡張することを保証するジェネリック型制約
type AnyZodObject = z.ZodObject<any, any, any, any>;

export class ToolManager {
  private plugin: ObsidianMemoria;
  private availableTools: StructuredTool<AnyZodObject>[];
  private toolMap: Map<string, StructuredTool<AnyZodObject>>;

  constructor(plugin: ObsidianMemoria) {
    this.plugin = plugin;
    this.availableTools = [];
    this.toolMap = new Map();
    this.initializeTools();
  }

  private initializeTools(): void {
    const conversationReflectionTool = new ConversationReflectionTool(this.plugin);
    const todoTool = new TodoTool(this.plugin);

    // registerTool は StructuredTool<AnyZodObject> を期待するため、
    // 各ツールがこの型に代入可能であることを確認
    this.registerTool(conversationReflectionTool);
    this.registerTool(todoTool);
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
   * ChatGoogleGenerativeAI の `tools` オプションは (BaseToolInterface | Record<string, any>)[] 型などを期待します。
   * StructuredTool は BaseToolInterface を実装しているはずです。
   */
  public getLangchainTools(): StructuredTool<AnyZodObject>[] {
    return this.availableTools;
  }

  public onSettingsChanged(): void {
    // ToolManager自体が持つ設定があればここで更新
    // 各ツールにも設定変更を通知
    this.availableTools.forEach(tool => {
      if (typeof (tool as any).onSettingsChanged === 'function') {
        (tool as any).onSettingsChanged();
      }
    });
    console.log('[ToolManager] Settings changed, notified all registered tools.');
  }
}
