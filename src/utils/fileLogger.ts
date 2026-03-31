// src/utils/fileLogger.ts
import { StorageAdapter } from '../core/interfaces/storageAdapter';

const DEBUG_LOG_DIR = 'DebugLog';

/**
 * セッション単位のファイルベースロガー。
 * LLMへの送信内容、レスポンス、内部処理の詳細をMarkdownファイルとして出力する。
 */
export class FileLogger {
  private storage: StorageAdapter;
  private sessionFilePath: string | null = null;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushIntervalMs = 2000;
  private isFlushing = false;
  private turnCounter = 0;
  private enabled = false;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  /**
   * 新しいセッションを開始する。セッションごとに新しいログファイルを作成。
   */
  public async startSession(): Promise<void> {
    if (!this.enabled) return;

    await this.flush(); // 前のセッションがあればフラッシュ

    const now = new Date();
    const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    await this.storage.ensureDir(DEBUG_LOG_DIR);

    this.sessionFilePath = `${DEBUG_LOG_DIR}/session-${timestamp}.md`;
    this.turnCounter = 0;
    this.buffer = [];

    this.appendToBuffer(`# Session Log: ${dateStr}\n\n`);
    await this.flush();
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  // --- ログメソッド ---

  /**
   * チャットターンの開始を記録する。
   */
  public logTurnStart(userInput: string): void {
    if (!this.enabled || !this.sessionFilePath) return;
    this.turnCounter++;
    this.appendToBuffer(`\n---\n\n## Turn #${this.turnCounter}\n\n`);
    this.appendToBuffer(`### User Input\n\n\`\`\`\n${userInput}\n\`\`\`\n\n`);
    this.scheduleFlush();
  }

  /**
   * システムプロンプトを記録する。
   */
  public logSystemPrompt(prompt: string): void {
    if (!this.enabled || !this.sessionFilePath) return;
    this.appendToBuffer(`### System Prompt (${prompt.length} chars)\n\n<details>\n<summary>Click to expand</summary>\n\n\`\`\`\n${prompt}\n\`\`\`\n\n</details>\n\n`);
    this.scheduleFlush();
  }

  /**
   * LLMに送信するメッセージ一覧を記録する。
   */
  public logMessagesForLlm(messages: Array<{ role: string; content: string; contentLength?: number }>): void {
    if (!this.enabled || !this.sessionFilePath) return;
    this.appendToBuffer(`### Messages Sent to LLM (${messages.length} messages)\n\n`);
    for (const msg of messages) {
      const content = msg.content.length > 500
        ? msg.content.substring(0, 500) + `... (${msg.content.length} chars total)`
        : msg.content;
      this.appendToBuffer(`- **${msg.role}** (${msg.content.length} chars): ${content.replace(/\n/g, '\n  ')}\n`);
    }
    this.appendToBuffer('\n');
    this.scheduleFlush();
  }

  /**
   * ストリーミングLLMレスポンスの完了を記録する。
   */
  public logStreamingResponse(response: string, metadata?: Record<string, any>): void {
    if (!this.enabled || !this.sessionFilePath) return;
    this.appendToBuffer(`### LLM Streaming Response (${response.length} chars)\n\n\`\`\`\n${response}\n\`\`\`\n\n`);
    if (metadata) {
      this.appendToBuffer(`#### Response Metadata\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n`);
    }
    this.scheduleFlush();
  }

  /**
   * ツール呼び出しを記録する。
   */
  public logToolCall(toolName: string, args: any, result: string): void {
    if (!this.enabled || !this.sessionFilePath) return;
    this.appendToBuffer(`### Tool Call: ${toolName}\n\n`);
    this.appendToBuffer(`#### Arguments\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n\n`);
    const truncatedResult = result.length > 2000
      ? result.substring(0, 2000) + `\n... (truncated, ${result.length} chars total)`
      : result;
    this.appendToBuffer(`#### Result\n\n\`\`\`\n${truncatedResult}\n\`\`\`\n\n`);
    this.scheduleFlush();
  }

  /**
   * LLM generate() 呼び出し（非ストリーミング）を記録する。
   * ReflectionEngine, TagProfiler, NarrativeBuffer 等で使用。
   */
  public logGenerateCall(category: string, prompt: string, response: string, options?: { tier?: string; parseResult?: any; error?: string }): void {
    if (!this.enabled || !this.sessionFilePath) return;
    const ts = this.timestamp();
    this.appendToBuffer(`\n### [${ts}] LLM Generate: ${category}${options?.tier ? ` (tier: ${options.tier})` : ''}\n\n`);
    this.appendToBuffer(`#### Prompt (${prompt.length} chars)\n\n<details>\n<summary>Click to expand</summary>\n\n\`\`\`\n${prompt}\n\`\`\`\n\n</details>\n\n`);
    this.appendToBuffer(`#### Response (${response.length} chars)\n\n\`\`\`\n${response}\n\`\`\`\n\n`);
    if (options?.parseResult !== undefined) {
      this.appendToBuffer(`#### Parsed Result\n\n\`\`\`json\n${JSON.stringify(options.parseResult, null, 2)}\n\`\`\`\n\n`);
    }
    if (options?.error) {
      this.appendToBuffer(`#### Error\n\n\`\`\`\n${options.error}\n\`\`\`\n\n`);
    }
    this.scheduleFlush();
  }

  /**
   * コンテキスト取得結果を記録する。
   */
  public logContextRetrieval(retrievedContext: string, narrativeSummary: string): void {
    if (!this.enabled || !this.sessionFilePath) return;
    this.appendToBuffer(`### Context Retrieved\n\n`);
    this.appendToBuffer(`#### Retrieved Memory Context (${retrievedContext.length} chars)\n\n<details>\n<summary>Click to expand</summary>\n\n\`\`\`\n${retrievedContext}\n\`\`\`\n\n</details>\n\n`);
    if (narrativeSummary) {
      this.appendToBuffer(`#### Narrative Summary\n\n\`\`\`\n${narrativeSummary}\n\`\`\`\n\n`);
    }
    this.scheduleFlush();
  }

  /**
   * 汎用ログエントリを記録する。
   */
  public log(category: string, message: string, data?: string): void {
    if (!this.enabled || !this.sessionFilePath) return;
    const ts = this.timestamp();
    this.appendToBuffer(`**[${ts}] ${category}**: ${message}\n`);
    if (data) {
      this.appendToBuffer(`\`\`\`\n${data}\n\`\`\`\n`);
    }
    this.appendToBuffer('\n');
    this.scheduleFlush();
  }

  // --- 内部メソッド ---

  private timestamp(): string {
    const now = new Date();
    const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  }

  private appendToBuffer(text: string): void {
    this.buffer.push(text);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(e => console.error('[FileLogger] Flush error:', e.message));
    }, this.flushIntervalMs);
  }

  /**
   * バッファの内容をファイルに書き出す。
   */
  public async flush(): Promise<void> {
    if (!this.sessionFilePath || this.buffer.length === 0 || this.isFlushing) return;
    this.isFlushing = true;

    const toWrite = this.buffer.splice(0);

    try {
      let existing = '';
      const fileExists = await this.storage.exists(this.sessionFilePath);
      if (fileExists) {
        existing = await this.storage.read(this.sessionFilePath);
      }
      await this.storage.write(this.sessionFilePath, existing + toWrite.join(''));
    } catch (e: any) {
      // 書き込みエラー時はバッファに戻す
      console.error('[FileLogger] Write error:', e.message);
      this.buffer.unshift(...toWrite);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * セッション終了時のクリーンアップ。
   */
  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
