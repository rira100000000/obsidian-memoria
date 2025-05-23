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

  constructor(app: App, llmRoleName: string) {
    this.app = app;
    this.llmRoleName = llmRoleName;
  }

  /**
   * ログファイルパスを取得します。
   * @returns {string | null} 現在のログファイルパス、または未設定の場合はnull。
   */
  public getLogFilePath(): string | null {
    return this.currentLogFilePath;
  }

  /**
   * 新しいログファイルを設定・作成します。
   * 以前のログファイルパスはクリアされます。
   * @param llmRoleName - LLMのロール名 (ログの参加者として記録するため)
   * @returns {Promise<string | null>} 作成されたログファイルのパス、またはエラー時はnull。
   */
  public async setupLogFile(llmRoleName?: string): Promise<string | null> {
    if (llmRoleName) {
        this.llmRoleName = llmRoleName;
    }
    try {
      const dirExists = await this.app.vault.adapter.exists(this.logDir);
      if (!dirExists) {
        await this.app.vault.createFolder(this.logDir);
        console.log(`[ChatLogger] Created directory: ${this.logDir}`);
      }
      const timestamp = moment().format('YYYYMMDDHHmmss');
      const newLogFilePath = `${this.logDir}/${timestamp}.md`;
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
        console.log(`[ChatLogger] Created log file: ${this.currentLogFilePath}`);
        return this.currentLogFilePath;
      } else {
        // 予期せずファイルが既に存在する場合のフォールバック (通常はタイムスタンプでユニークになるはず)
        console.warn(`[ChatLogger] Log file already exists, attempting to use a new timestamp: ${newLogFilePath}`);
        this.currentLogFilePath = null; // 一旦クリア
        return this.setupLogFile(this.llmRoleName); // 再試行
      }
    } catch (error: any) {
      console.error('[ChatLogger] Error setting up logging:', error.message);
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
      console.warn('[ChatLogger] Log file path is not set. Cannot append entry.');
      return;
    }
    const file = this.app.vault.getFileByPath(this.currentLogFilePath);
    if (file instanceof TFile) {
      try {
        await this.app.vault.append(file, entry);
      } catch (error: any) {
        console.error(`[ChatLogger] Error appending to log file ${this.currentLogFilePath}:`, error.message);
      }
    } else {
      console.error(`[ChatLogger] Log file not found for appending: ${this.currentLogFilePath}`);
    }
  }

  /**
   * 現在のログファイルパスをリセットします。
   */
  public resetLogFile(): void {
    this.currentLogFilePath = null;
    console.log('[ChatLogger] Log file path has been reset.');
  }

  /**
   * 指定されたパスのログファイルを削除します。
   * @param {string} filePath - 削除するログファイルのパス。
   * @returns {Promise<boolean>} 削除に成功した場合はtrue、それ以外はfalse。
   */
  public async deleteLogFile(filePath: string): Promise<boolean> {
    const logFile = this.app.vault.getAbstractFileByPath(filePath);
    if (logFile instanceof TFile) {
      try {
        await this.app.vault.delete(logFile);
        new Notice(`チャットログファイル ${filePath} を削除しました。`);
        console.log(`[ChatLogger] Deleted log file: ${filePath}`);
        if (this.currentLogFilePath === filePath) {
          this.currentLogFilePath = null; // 削除したファイルが現在のログファイルならパスをクリア
        }
        return true;
      } catch (error: any) {
        new Notice(`チャットログファイル ${filePath} の削除に失敗しました。`);
        console.error(`[ChatLogger] Error deleting log file ${filePath}:`, error.message);
        return false;
      }
    } else {
      new Notice(`削除対象のチャットログファイル ${filePath} が見つかりませんでした。`);
      console.warn(`[ChatLogger] Log file not found for deletion: ${filePath}`);
      if (this.currentLogFilePath === filePath) {
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
        console.warn('[ChatLogger] Cannot update frontmatter, file path is null.');
        return;
    }
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
            console.log(`[ChatLogger] Updated frontmatter for log file: ${filePath}`);
        } catch (error: any) {
            console.error(`[ChatLogger] Error updating frontmatter for ${filePath}:`, error.message);
            new Notice(`ログファイル (${filePath}) のフロントマター更新に失敗しました。`);
        }
    } else {
        console.warn(`[ChatLogger] Could not find log file to update frontmatter: ${filePath}`);
    }
  }
}
