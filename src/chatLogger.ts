// src/ui/chatLogger.ts
import { App, TFile, moment, Notice } from 'obsidian';

/**
 * ChatLoggerクラス
 * チャットのログ記録、ファイル管理を担当します。
 */
export class ChatLogger {
  private app: App;
  private llmRoleName: string;
  private currentLogFilePath: string | null = null;
  private readonly logDir = 'FullLog'; // ログを保存するディレクトリ
  private instanceId: string; // デバッグ用のインスタンスID

  constructor(app: App, llmRoleName: string) {
    this.app = app;
    this.llmRoleName = llmRoleName;
    this.instanceId = Math.random().toString(36).substring(2, 8); // ランダムなIDを生成
    console.log(`[ChatLogger][${this.instanceId}] New instance created. RoleName: ${llmRoleName}`);
  }

  /**
   * ログファイルパスを取得します。
   * @returns {string | null} 現在のログファイルパス、または未設定の場合はnull。
   */
  public getLogFilePath(): string | null {
    console.log(`[ChatLogger][${this.instanceId}] getLogFilePath called. Returning: ${this.currentLogFilePath}`);
    return this.currentLogFilePath;
  }

  /**
   * 新しいログファイルを設定・作成します。
   * 以前のログファイルパスはクリアされます。
   * @param llmRoleName - LLMのロール名 (ログの参加者として記録するため)
   * @returns {Promise<string | null>} 作成されたログファイルのパス、またはエラー時はnull。
   */
  public async setupLogFile(llmRoleName?: string): Promise<string | null> {
    const originalRoleName = this.llmRoleName;
    if (llmRoleName) {
        this.llmRoleName = llmRoleName;
        console.log(`[ChatLogger][${this.instanceId}] setupLogFile: llmRoleName updated from '${originalRoleName}' to '${this.llmRoleName}'`);
    } else {
        console.log(`[ChatLogger][${this.instanceId}] setupLogFile: llmRoleName not provided, using existing '${this.llmRoleName}'`);
    }

    try {
      console.log(`[ChatLogger][${this.instanceId}] Attempting to set up log file in directory: ${this.logDir}`);
      const dirExists = await this.app.vault.adapter.exists(this.logDir);
      if (!dirExists) {
        await this.app.vault.createFolder(this.logDir);
        console.log(`[ChatLogger][${this.instanceId}] Created directory: ${this.logDir}`);
      }
      const timestamp = moment().format('YYYYMMDDHHmmss');
      const newLogFilePath = `${this.logDir}/${timestamp}.md`;
      console.log(`[ChatLogger][${this.instanceId}] Proposed new log file path: ${newLogFilePath}`);
      const currentDate = moment().format('YYYY-MM-DD HH:mm:ss');
      const initialLogContent = `---
title: undefined
date: ${currentDate}
type: full_log
summary_note: undefined
participants:
  - User
  - ${this.llmRoleName}
---
# 会話ログ: undefined
**日時**: ${currentDate}
---
`;
      const logFileExists = await this.app.vault.adapter.exists(newLogFilePath);
      if (!logFileExists) {
        await this.app.vault.create(newLogFilePath, initialLogContent);
        this.currentLogFilePath = newLogFilePath;
        console.log(`[ChatLogger][${this.instanceId}] Successfully created log file. currentLogFilePath set to: ${this.currentLogFilePath}`);
        return this.currentLogFilePath;
      } else {
        console.warn(`[ChatLogger][${this.instanceId}] Log file already exists (should be rare with timestamp): ${newLogFilePath}. Attempting to use a new timestamp by retrying.`);
        this.currentLogFilePath = null; // 一旦クリア
        return this.setupLogFile(this.llmRoleName); // 再試行
      }
    } catch (error: any) {
      console.error(`[ChatLogger][${this.instanceId}] Error setting up logging:`, error.message, error.stack);
      new Notice('チャットログファイルの作成または確認に失敗しました。');
      this.currentLogFilePath = null;
      return null;
    }
  }

  /**
   * 現在のログファイルにエントリを追記します。
   * @param {string} entry - ログに追記する文字列。
   * @returns {Promise<void>}
   */
  public async appendLogEntry(entry: string): Promise<void> {
    if (!this.currentLogFilePath) {
      console.warn(`[ChatLogger][${this.instanceId}] appendLogEntry: Log file path is not set. Cannot append entry.`);
      return;
    }
    const file = this.app.vault.getFileByPath(this.currentLogFilePath);
    if (file instanceof TFile) {
      try {
        await this.app.vault.append(file, entry);
      } catch (error: any) {
        console.error(`[ChatLogger][${this.instanceId}] Error appending to log file ${this.currentLogFilePath}:`, error.message);
      }
    } else {
      console.error(`[ChatLogger][${this.instanceId}] appendLogEntry: Log file not found for appending: ${this.currentLogFilePath}`);
    }
  }

  /**
   * 現在のログファイルパスをリセットします。
   */
  public resetLogFile(): void {
    console.log(`[ChatLogger][${this.instanceId}] resetLogFile called. Current path '${this.currentLogFilePath}' will be set to null.`);
    this.currentLogFilePath = null;
    // console.log(`[ChatLogger][${this.instanceId}] Log file path has been reset.`); // このログはユーザー提供ログと重複するのでコメントアウト
  }

  /**
   * 指定されたパスのログファイルを削除します。
   * @param {string} filePath - 削除するログファイルのパス。
   * @returns {Promise<boolean>} 削除に成功した場合はtrue、それ以外はfalse。
   */
  public async deleteLogFile(filePath: string): Promise<boolean> {
    console.log(`[ChatLogger][${this.instanceId}] Attempting to delete log file: ${filePath}`);
    const logFile = this.app.vault.getAbstractFileByPath(filePath);
    if (logFile instanceof TFile) {
      try {
        await this.app.vault.delete(logFile);
        new Notice(`チャットログファイル ${filePath} を削除しました。`);
        console.log(`[ChatLogger][${this.instanceId}] Successfully deleted log file: ${filePath}`);
        if (this.currentLogFilePath === filePath) {
          console.log(`[ChatLogger][${this.instanceId}] Deleted file was current log file. Resetting currentLogFilePath.`);
          this.currentLogFilePath = null; // 削除したファイルが現在のログファイルならパスをクリア
        }
        return true;
      } catch (error: any) {
        new Notice(`チャットログファイル ${filePath} の削除に失敗しました。`);
        console.error(`[ChatLogger][${this.instanceId}] Error deleting log file ${filePath}:`, error.message);
        return false;
      }
    } else {
      new Notice(`削除対象のチャットログファイル ${filePath} が見つかりませんでした。`);
      console.warn(`[ChatLogger][${this.instanceId}] Log file not found for deletion: ${filePath}`);
      if (this.currentLogFilePath === filePath) {
        console.log(`[ChatLogger][${this.instanceId}] Non-existent file was current log file. Resetting currentLogFilePath.`);
        this.currentLogFilePath = null;
      }
      return false;
    }
  }

  /**
   * ログファイルのフロントマターを更新します。
   * @param filePath - 更新するログファイルのパス。
   * @param updates - フロントマターに適用する更新内容。
   * @returns {Promise<void>}
   */
  public async updateLogFileFrontmatter(filePath: string, updates: Record<string, any>): Promise<void> {
    if (!filePath) {
        console.warn(`[ChatLogger][${this.instanceId}] Cannot update frontmatter, file path is null.`);
        return;
    }
    console.log(`[ChatLogger][${this.instanceId}] Attempting to update frontmatter for log file: ${filePath} with updates:`, updates);
    const logFile = this.app.vault.getAbstractFileByPath(filePath);
    if (logFile instanceof TFile) {
        try {
            await this.app.fileManager.processFrontMatter(logFile, (fm) => {
                for (const key in updates) {
                    if (Object.prototype.hasOwnProperty.call(updates, key)) {
                        fm[key] = updates[key];
                    }
                }
            });
            console.log(`[ChatLogger][${this.instanceId}] Successfully updated frontmatter for log file: ${filePath}`);
        } catch (error: any) {
            console.error(`[ChatLogger][${this.instanceId}] Error updating frontmatter for ${filePath}:`, error.message);
            new Notice(`ログファイル (${filePath}) のフロントマター更新に失敗しました。`);
        }
    } else {
        console.warn(`[ChatLogger][${this.instanceId}] Could not find log file to update frontmatter: ${filePath}`);
    }
  }
}