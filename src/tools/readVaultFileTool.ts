// src/tools/readVaultFileTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import ObsidianMemoria from "../../main";

const ReadVaultFileToolSchema = z.object({
  file_path: z.string().describe("読み取るファイルのパス（例: 'SummaryNote/SN-202603272236-タイトル.md', 'TagProfilingNote/TPN-Ruby.md'）"),
});

export type ReadVaultFileToolInput = z.infer<typeof ReadVaultFileToolSchema>;

export class ReadVaultFileTool extends StructuredTool<typeof ReadVaultFileToolSchema> {
  schema = ReadVaultFileToolSchema;

  name = "read_vault_file";
  description = `Vault内のファイルを読み取るツール。SummaryNote、TagProfilingNote、BehaviorPrinciplesなどのファイルを指定パスで読み取れる。
Deep Reflection時に自分の記憶（SN/TPN）を能動的に読むために使用する。`;

  private plugin: ObsidianMemoria;

  constructor(plugin: ObsidianMemoria) {
    super();
    this.plugin = plugin;
  }

  protected async _call(input: ReadVaultFileToolInput): Promise<string> {
    try {
      const exists = await this.plugin.storage.exists(input.file_path);
      if (!exists) {
        return JSON.stringify({ success: false, error: `ファイルが見つかりません: ${input.file_path}` });
      }
      const content = await this.plugin.storage.read(input.file_path);
      // 巨大ファイルは先頭を切り詰め
      const maxLength = 8000;
      const truncated = content.length > maxLength;
      return JSON.stringify({
        success: true,
        file_path: input.file_path,
        content: truncated ? content.substring(0, maxLength) + '\n... (truncated)' : content,
        truncated,
        total_length: content.length,
      });
    } catch (e: any) {
      return JSON.stringify({ success: false, error: `読み取りエラー: ${e.message}` });
    }
  }
}
