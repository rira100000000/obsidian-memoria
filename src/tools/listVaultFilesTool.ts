// src/tools/listVaultFilesTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { parse as parseYaml } from 'yaml';
import ObsidianMemoria from "../../main";

const ListVaultFilesToolSchema = z.object({
  directory: z.enum(['SummaryNote', 'TagProfilingNote', 'BehaviorPrinciples', 'FullLog']).describe(
    "一覧を取得するディレクトリ。SummaryNote: 会話サマリー一覧、TagProfilingNote: タグプロファイル一覧、BehaviorPrinciples: 行動原則、FullLog: 会話ログ一覧"
  ),
  include_frontmatter: z.boolean().optional().describe("trueの場合、各ファイルのfrontmatter（title, date, tags等）も取得する。デフォルトfalse。"),
});

export type ListVaultFilesToolInput = z.infer<typeof ListVaultFilesToolSchema>;

export class ListVaultFilesTool extends StructuredTool<typeof ListVaultFilesToolSchema> {
  schema = ListVaultFilesToolSchema;

  name = "list_vault_files";
  description = `Vault内の指定ディレクトリのファイル一覧を取得するツール。
SummaryNote（会話サマリー）やTagProfilingNote（タグプロファイル）の一覧を確認し、読むべきファイルを判断するために使用する。
include_frontmatter=trueで各ファイルのタイトル・日付・タグなどのメタデータも取得できる。`;

  private plugin: ObsidianMemoria;

  constructor(plugin: ObsidianMemoria) {
    super();
    this.plugin = plugin;
  }

  protected async _call(input: ListVaultFilesToolInput): Promise<string> {
    try {
      const files = await this.plugin.storage.listMarkdownFiles(input.directory);
      if (files.length === 0) {
        return JSON.stringify({ success: true, directory: input.directory, count: 0, files: [] });
      }

      if (!input.include_frontmatter) {
        const fileNames = files.map(f => f.replace(/^.*\//, ''));
        return JSON.stringify({
          success: true,
          directory: input.directory,
          count: fileNames.length,
          files: fileNames,
        });
      }

      // frontmatter付きで返す
      const fileInfos = await Promise.all(files.map(async (filePath) => {
        const fileName = filePath.replace(/^.*\//, '');
        try {
          const content = await this.plugin.storage.read(filePath);
          const fmMatch = content.match(/^---([\s\S]+?)---/);
          if (fmMatch) {
            const fm = parseYaml(fmMatch[1]);
            return {
              file_name: fileName,
              file_path: filePath,
              title: fm.title || fm.tag_name || undefined,
              date: fm.date || fm.updated_date || undefined,
              tags: fm.tags || undefined,
              type: fm.type || undefined,
            };
          }
          return { file_name: fileName, file_path: filePath };
        } catch {
          return { file_name: fileName, file_path: filePath };
        }
      }));

      return JSON.stringify({
        success: true,
        directory: input.directory,
        count: fileInfos.length,
        files: fileInfos,
      });
    } catch (e: any) {
      return JSON.stringify({ success: false, error: `一覧取得エラー: ${e.message}` });
    }
  }
}
