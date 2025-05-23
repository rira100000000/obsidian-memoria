// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice, moment, TFile, Modal, App, Setting } from 'obsidian';
import ObsidianMemoria from '../../main';
import { GeminiPluginSettings } from '../settings';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate
} from "@langchain/core/prompts";
import { SummaryGenerator } from '../summaryGenerator';
import { TagProfiler } from '../tagProfiler';
import { ContextRetriever, RetrievedContext } from '../contextRetriever';

export const CHAT_VIEW_TYPE = 'obsidian-memoria-chat-view';

// 警告モーダルクラス (変更なし)
class ConfirmationModal extends Modal {
  constructor(app: App, private titleText: string, private messageText: string, private onConfirm: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.titleText);
    contentEl.createEl('p', { text: this.messageText });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('はい (Yes)')
          .setCta()
          .onClick(() => {
            this.onConfirm();
            this.close();
          }))
      .addButton((btn) =>
        btn
          .setButtonText('いいえ (No)')
          .onClick(() => {
            this.close();
          }));
  }

  onClose() {
    this.contentEl.empty();
  }
}


export class ChatView extends ItemView {
  plugin: ObsidianMemoria;
  settings: GeminiPluginSettings;
  chatMessagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;

  private messageHistory = new ChatMessageHistory();
  private chatModel: ChatGoogleGenerativeAI | null = null;
  private chainWithHistory: RunnableWithMessageHistory<Record<string, any>, BaseMessage> | null = null;
  private contextRetriever: ContextRetriever;

  private logFilePath: string | null = null;
  private llmRoleName = 'Assistant';
  private summaryGenerator: SummaryGenerator;
  private tagProfiler: TagProfiler;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.summaryGenerator = new SummaryGenerator(this.plugin);
    this.tagProfiler = new TagProfiler(this.plugin);
    this.contextRetriever = new ContextRetriever(this.plugin);
  }

  private getLlmRoleName(systemPrompt: string): string {
    if (!systemPrompt) return 'Assistant';
    let match;
    match = systemPrompt.match(/named\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/Your name is\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/Your role is\s+([\w\s-]+)(?:\.|$)/i);
    if (match && match[1]) return match[1].trim();
    match = systemPrompt.match(/^You are (?:a|an)\s+([\w\s-]+?)(?:\.|$)/i);
    if (match && match[1]) {
        const role = match[1].trim();
        const lowerRole = role.toLowerCase();
        if (lowerRole === 'helpful assistant' || lowerRole === 'ai assistant' || lowerRole === 'assistant') {
            return 'Assistant';
        }
        return role;
    }
    return 'Assistant';
  }

  private initializeChatModel() {
    this.settings = this.plugin.settings;
    const baseSystemPrompt = this.settings.systemPrompt || "You are a helpful assistant integrated into Obsidian.";
    this.llmRoleName = this.getLlmRoleName(baseSystemPrompt);

    // 現在時刻をシステムプロンプトに含めるための指示を追加
    const currentTimeInstruction = `
Current time is {current_time}. Please consider this time when formulating your response, especially if the user's query is time-sensitive.
`;

    const memoryContextInstruction = `

## 記憶からの参考情報 (Memory Recall Information):
{retrieved_context_string}

**指示:**
上記の「記憶からの参考情報」は、あなたとユーザーとの過去の会話や関連ノートから抜粋されたものです。
現在のユーザーの入力「{input}」に回答する際には、この情報を**最優先で考慮し、積極的に活用**してください。
- 情報がユーザーの入力に直接関連する場合、その情報を基に具体的かつ文脈に沿った応答を生成してください。
- ユーザーが過去に示した意見、経験、好み（例：好きなもの、嫌いなもの、以前の決定など）が情報に含まれている場合、それを応答に反映させ、一貫性のある対話を目指してください。
- 「記憶からの参考情報」が「記憶からの関連情報は見つかりませんでした。」となっている場合は、過去の記憶が存在しているような振る舞いをしないでください。
- もし提供された情報が現在の質問と無関係である、または不正確であると明確に判断できる場合に限り、その情報を無視しても構いません。その際は、なぜ無視したのかを簡潔に説明する必要はありません。
`;
    // システムプロンプトテンプレートに現在時刻の指示を組み込む
    const finalSystemPromptTemplate = currentTimeInstruction + baseSystemPrompt + memoryContextInstruction;


    if (this.settings.geminiApiKey && this.settings.geminiModel) {
      try {
        this.chatModel = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: this.settings.geminiModel,
        });

        // SystemMessage をテンプレートとして定義
        // finalSystemPromptTemplate は {current_time}, {retrieved_context_string}, {input} を期待する
        const systemMessagePrompt = SystemMessagePromptTemplate.fromTemplate(finalSystemPromptTemplate);
        // HumanMessage をテンプレートとして定義
        const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate("{input}");

        const prompt = ChatPromptTemplate.fromMessages([
          systemMessagePrompt,
          new MessagesPlaceholder("history"),
          humanMessagePrompt,
        ]);

        const chain = prompt.pipe(this.chatModel);
        this.chainWithHistory = new RunnableWithMessageHistory({
            runnable: chain,
            getMessageHistory: (_sessionId) => this.messageHistory,
            inputMessagesKey: "input", // {input} に対応
            historyMessagesKey: "history",
            // chain.invoke に渡すオブジェクトに current_time と retrieved_context_string を含める必要がある
        });
        console.log(`[MemoriaChat] Chat model initialized. LLM Role: ${this.llmRoleName}`);
        console.log(`[MemoriaChat] System prompt template being used (includes current_time placeholder): ${finalSystemPromptTemplate}`);
      } catch (error: any) {
        console.error('[MemoriaChat] Failed to initialize ChatGoogleGenerativeAI model or chain:', error.message);
        new Notice('Geminiモデルまたはチャットチェーンの初期化に失敗しました。');
        this.chatModel = null;
        this.chainWithHistory = null;
      }
    } else {
      console.log('[MemoriaChat] API key or model name not set. Chat model not initialized.');
      this.chatModel = null;
      this.chainWithHistory = null;
    }
  }

  onSettingsChanged() {
    this.initializeChatModel();
    this.summaryGenerator.onSettingsChanged();
    this.tagProfiler.onSettingsChanged();
    this.contextRetriever.onSettingsChanged();
    console.log('[MemoriaChat] Settings changed, all relevant modules re-initialized.');
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return 'Memoria Chat'; }
  getIcon() { return 'messages-square'; }

  async onOpen() {
    this.settings = this.plugin.settings;
    this.initializeChatModel();
    this.contextRetriever.onSettingsChanged();

    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('memoria-chat-view-container');

    const styleEl = container.createEl('style');
    styleEl.textContent = `
      .memoria-chat-view-container { display: flex; flex-direction: column; height: 100%; }
      .memoria-chat-header { display: flex; justify-content: flex-end; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--background-modifier-border); background-color: var(--background-primary); flex-shrink: 0; }
      .memoria-chat-header button { margin-left: 8px; }
      .memoria-chat-messages-wrapper { flex-grow: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; }
      .memoria-chat-messages-inner { display: flex; flex-direction: column; }
      .memoria-chat-message { margin-bottom: 8px; padding: 8px 12px; border-radius: 12px; max-width: 85%; width: fit-content; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      .user-message { background-color: var(--interactive-accent); color: var(--text-on-accent); align-self: flex-end; }
      .model-message { background-color: var(--background-secondary); align-self: flex-start; }
      .model-message.loading { color: var(--text-muted); font-style: italic; }
      .memoria-chat-input-form { display: flex; padding: 10px; border-top: 1px solid var(--background-modifier-border); background-color: var(--background-primary); flex-shrink: 0; align-items: flex-end; }
      .memoria-chat-input-textarea { flex-grow: 1; margin-right: 8px; resize: none; font-family: inherit; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); padding: 8px; min-height: 40px; max-height: 200px; overflow-y: auto; }
      .memoria-chat-send-button { align-self: flex-end; min-height: 40px; }
    `;

    const chatHeaderEl = container.createEl('div', { cls: 'memoria-chat-header' });

    const newChatButton = chatHeaderEl.createEl('button', {
      text: 'New Chat',
      cls: 'mod-cta memoria-new-chat-button'
    });
    newChatButton.addEventListener('click', () => this.resetChat());

    const discardChatButton = chatHeaderEl.createEl('button', {
        text: 'Discard Chat',
        cls: 'mod-warning memoria-discard-chat-button'
    });
    discardChatButton.addEventListener('click', () => this.confirmAndDiscardChat());


    const messagesWrapperEl = container.createEl('div', { cls: 'memoria-chat-messages-wrapper' });
    this.chatMessagesEl = messagesWrapperEl.createEl('div', { cls: 'memoria-chat-messages-inner' });
    this.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');

    const inputFormEl = container.createEl('form', { cls: 'memoria-chat-input-form' });
    inputFormEl.addEventListener('submit', (event) => {
      event.preventDefault(); this.sendMessage();
    });

    this.inputEl = inputFormEl.createEl('textarea', {
      attr: { placeholder: 'メッセージを入力 (Shift+Enterで送信)', rows: 1 },
      cls: 'memoria-chat-input-textarea'
    });
    this.inputEl.addEventListener('input', () => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
    });
    this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault(); this.sendMessage();
      }
    });
    inputFormEl.createEl('button', {
      text: '送信', type: 'submit', cls: 'mod-cta memoria-chat-send-button'
    });

    if (!this.chainWithHistory) {
        new Notice('Geminiチャット機能が利用できません。設定（APIキー、モデル名）を確認してください。', 0);
    }
  }

  private async setupLogging() {
    const logDir = 'FullLog';
    try {
      if (!this.llmRoleName || this.llmRoleName === 'Assistant') {
        const systemPromptFromSettings = this.settings.systemPrompt || "You are a helpful assistant integrated into Obsidian.";
        this.llmRoleName = this.getLlmRoleName(systemPromptFromSettings);
      }

      const dirExists = await this.app.vault.adapter.exists(logDir);
      if (!dirExists) {
        await this.app.vault.createFolder(logDir);
        console.log(`[MemoriaChat] Created directory: ${logDir}`);
      }
      const timestamp = moment().format('YYYYMMDDHHmmss');
      this.logFilePath = `${logDir}/${timestamp}.md`;
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
      const logFileExists = await this.app.vault.adapter.exists(this.logFilePath);
      if (!logFileExists) {
        await this.app.vault.create(this.logFilePath, initialLogContent);
        console.log(`[MemoriaChat] Created log file: ${this.logFilePath}`);
      } else {
        console.log(`[MemoriaChat] Log file already exists, not overwriting: ${this.logFilePath}`);
      }
    } catch (error: any) {
      console.error('[MemoriaChat] Error setting up logging:', error.message);
      new Notice('チャットログファイルの作成または確認に失敗しました。');
      this.logFilePath = null;
    }
  }

  async onClose() {
    // Clean up resources if needed
  }

  private async confirmAndDiscardChat() {
    const messages = await this.messageHistory.getMessages();
    if (!this.logFilePath && messages.length <= 1) {
        new Notice('破棄するチャットログがありません。');
        await this.resetChat(true);
        new Notice('現在のチャット（ログなし）が破棄され、新しいチャットが開始されました。');
        return;
    }

    const modal = new ConfirmationModal(
        this.app,
        'チャット履歴の破棄',
        '現在のチャット履歴を完全に破棄しますか？この操作は元に戻せません。ログファイルも削除されます。',
        async () => {
            await this.discardCurrentChatLogAndReset();
        }
    );
    modal.open();
  }

  private async discardCurrentChatLogAndReset() {
    if (this.logFilePath) {
        const logFile = this.app.vault.getAbstractFileByPath(this.logFilePath);
        if (logFile instanceof TFile) {
            try {
                await this.app.vault.delete(logFile);
                new Notice(`チャットログファイル ${this.logFilePath} を削除しました。`);
                console.log(`[MemoriaChat] Deleted log file: ${this.logFilePath}`);
            } catch (error) {
                new Notice(`チャットログファイル ${this.logFilePath} の削除に失敗しました。`);
                console.error(`[MemoriaChat] Error deleting log file ${this.logFilePath}:`, error);
            }
        } else {
            new Notice(`チャットログファイル ${this.logFilePath} が見つかりませんでした。UIはリセットされます。`);
            console.warn(`[MemoriaChat] Log file not found for deletion: ${this.logFilePath}`);
        }
        this.logFilePath = null;
    } else {
        console.log('[MemoriaChat] No log file path set, resetting UI and history.');
    }
    await this.resetChat(true);
    new Notice('現在のチャットが破棄され、新しいチャットが開始されました。');
  }


  private async resetChat(skipSummary = false) {
    const previousLogPath = this.logFilePath;
    const previousLlmRoleName = this.llmRoleName;

    this.logFilePath = null;

    if (this.chatMessagesEl) {
      this.chatMessagesEl.empty();
    }
    this.messageHistory = new ChatMessageHistory();
    this.appendModelMessage('チャットウィンドウへようこそ！\nShift+Enterでメッセージを送信します。');
    this.scrollToBottom();

    if (this.inputEl) {
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.inputEl.focus();
    }

    console.log('[MemoriaChat] Chat has been reset.');

    if (!skipSummary) {
        new Notice('新しいチャットが開始されました。');
    }


    if (!skipSummary && previousLogPath && previousLlmRoleName) {
      new Notice(`前のチャットの要約をバックグラウンドで生成開始します: ${previousLogPath}`);
      this.summaryGenerator.generateSummary(previousLogPath, previousLlmRoleName)
        .then(async (summaryNoteFile: TFile | null) => {
          if (summaryNoteFile) {
            console.log(`[MemoriaChat] Summary generation completed: ${summaryNoteFile.path}`);
            new Notice(`サマリーノートが生成されました: ${summaryNoteFile.basename}`);
            try {
              await this.tagProfiler.processSummaryNote(summaryNoteFile);
              console.log(`[MemoriaChat] Tag profiling initiated for ${summaryNoteFile.path}`);
              new Notice(`タグプロファイル処理を開始しました: ${summaryNoteFile.basename}`);
            } catch (tpError: any) {
              console.error(`[MemoriaChat] Error during tag profiling for ${summaryNoteFile.path}:`, tpError.message, tpError.stack);
              new Notice(`タグプロファイル処理中にエラーが発生しました: ${summaryNoteFile.basename}`);
            }
          } else {
            console.log(`[MemoriaChat] Summary generation for ${previousLogPath} did not return a file.`);
            new Notice(`前のチャット (${previousLogPath}) のサマリーノートファイルが取得できませんでした。`);
          }
        })
        .catch(error => {
          console.error(`[MemoriaChat] Summary generation failed for ${previousLogPath}:`, error);
          new Notice(`前のチャット (${previousLogPath}) の要約作成に失敗しました。`);
        });
    } else if (skipSummary) {
      console.log('[MemoriaChat] Summary generation skipped for previous chat.');
    }
  }

  private appendMessage(message: string, type: 'user' | 'model' | 'loading') {
    const messageEl = this.chatMessagesEl.createEl('div', {
        cls: `memoria-chat-message ${type}-message ${type === 'loading' ? 'loading' : ''}`
    });
    messageEl.setText(message);
    this.scrollToBottom();
    return messageEl;
  }

  appendUserMessage(message: string) { this.appendMessage(message, 'user'); }
  appendModelMessage(message: string) { this.appendMessage(message, 'model'); }

  scrollToBottom() {
    const wrapper = this.chatMessagesEl.parentElement;
    if (wrapper) {
      setTimeout(() => { wrapper.scrollTop = wrapper.scrollHeight; }, 50);
    }
  }

  async sendMessage() {
    const rawMessageContent = this.inputEl.value;
    const trimmedMessageContent = rawMessageContent.trim();

    if (!trimmedMessageContent) {
      if (rawMessageContent.length > 0) new Notice("メッセージが空白です。送信は行いません。");
      this.inputEl.value = ''; this.inputEl.style.height = 'auto'; this.inputEl.focus();
      return;
    }

    if (!this.logFilePath) {
        await this.setupLogging();
        if (!this.logFilePath) {
            this.appendModelMessage('エラー: ログファイルの作成に失敗したため、メッセージを送信できません。');
            new Notice('ログファイルの作成に失敗しました。');
            return;
        }
    }

    this.appendUserMessage(trimmedMessageContent);

    if (this.logFilePath) {
      const file = this.app.vault.getFileByPath(this.logFilePath);
      if (file instanceof TFile) {
        const userLogEntry = `**User**: ${trimmedMessageContent}\n`;
        try {
          await this.app.vault.append(file, userLogEntry);
        } catch (error) {
          console.error('[MemoriaChat] Error appending user message to log:', error);
        }
      } else {
          console.error("[MemoriaChat] Log file not found for appending user message:", this.logFilePath);
      }
    }

    this.inputEl.value = ''; this.inputEl.style.height = 'auto'; this.inputEl.focus();

    if (!this.chainWithHistory) {
      this.appendModelMessage('エラー: チャットチェーンが初期化されていません。プラグイン設定を確認してください。');
      new Notice('チャット機能が利用できません。設定を確認してください。');
      this.initializeChatModel();
      if(!this.chainWithHistory) return;
    }

    const loadingMessageEl = this.appendMessage('応答を待っています...', 'loading');

    let retrievedContextString = "記憶からの関連情報は見つかりませんでした。";
    try {
        const currentChatHistoryMessages = await this.messageHistory.getMessages();
        const retrievedContextResult: RetrievedContext = await this.contextRetriever.retrieveContextForPrompt(
            trimmedMessageContent,
            this.llmRoleName,
            currentChatHistoryMessages
        );

        if (retrievedContextResult.llmContextPrompt && retrievedContextResult.llmContextPrompt.trim() !== "") {
            retrievedContextString = retrievedContextResult.llmContextPrompt;
        }

    } catch (contextError: any) {
        console.error('[MemoriaChat] Error retrieving context:', contextError.message, contextError.stack);
        new Notice('記憶情報の取得中にエラーが発生しました。デフォルトのコンテキストを使用します。');
    }

    // 現在時刻を取得
    const currentTime = moment().format('YYYY-MM-DD HH:mm:ss dddd'); // 例: 2023-10-27 15:30:00 Friday

    try {
      // 実際にLLMに渡されるシステムプロンプトの内容（プレースホルダー展開後）をログに出力
      const baseSystemPrompt = this.settings.systemPrompt || "You are a helpful assistant integrated into Obsidian.";
      const currentTimeInstructionForLog = `
Current time is ${currentTime}. Please consider this time when formulating your response, especially if the user's query is time-sensitive.
`;
      const memoryContextInstructionForLog = `

## 記憶からの参考情報 (Memory Recall Information):
${retrievedContextString}

**指示:**
上記の「記憶からの参考情報」は、あなたとユーザーとの過去の会話や関連ノートから抜粋されたものです。
現在のユーザーの質問「${trimmedMessageContent}」に回答する際には、この情報を**最優先で考慮し、積極的に活用**してください。
- 情報がユーザーの質問に直接関連する場合、その情報を基に具体的かつ文脈に沿った応答を生成してください。
- ユーザーが過去に示した意見、経験、好み（例：好きなもの、嫌いなもの、以前の決定など）が情報に含まれている場合、それを応答に反映させ、一貫性のある対話を目指してください。
- 情報を参照したことが明確にわかる場合は、「以前お話しいただいた〇〇の件ですが…」や「〇〇がお好きだと記憶していますが…」のように、自然な形で言及してください。
- もし提供された情報が現在の質問と無関係である、または不正確であると明確に判断できる場合に限り、その情報を無視しても構いません。その際は、なぜ無視したのかを簡潔に説明する必要はありません。
- 「記憶からの参考情報」が「記憶からの関連情報は見つかりませんでした。」となっている場合は、ユーザーの現在の質問にのみ基づいて応答してください。
`;
      const effectiveSystemPromptForLogging = currentTimeInstructionForLog + baseSystemPrompt + memoryContextInstructionForLog;
      console.log("[MemoriaChat] Effective system prompt content being prepared for LLM:", effectiveSystemPromptForLogging);
      console.log("[MemoriaChat] Context string to be used in prompt:", retrievedContextString);
      console.log("[MemoriaChat] Current time string to be used in prompt:", currentTime);


      const chainInput = {
        input: trimmedMessageContent,
        retrieved_context_string: retrievedContextString,
        current_time: currentTime // 現在時刻を渡す
      };
      // invoke前に、実際に渡す chainInput の内容をログに出力
      console.log("[MemoriaChat] Invoking chain with input:", JSON.stringify(chainInput, null, 2));

      const response = await this.chainWithHistory.invoke(
        chainInput,
        { configurable: { sessionId: "obsidian-memoria-session" } }
      );
      loadingMessageEl.remove();
      let responseText = '';

      if (response && typeof response.content === 'string') {
        responseText = response.content;
      } else if (response && Array.isArray(response.content) && response.content.length > 0 && typeof response.content[0] === 'object' && response.content[0] !== null && 'text' in response.content[0]) {
        responseText = (response.content[0] as any).text;
      } else {
        console.error('[MemoriaChat] Invalid response format:', response);
        responseText = 'エラー: 予期しない形式の応答がありました。';
      }
      this.appendModelMessage(responseText);

      if (this.logFilePath && responseText) {
        const file = this.app.vault.getFileByPath(this.logFilePath);
        if (file instanceof TFile) {
            const modelLogEntry = `**${this.llmRoleName}**: ${responseText}\n`;
            try {
                await this.app.vault.append(file, modelLogEntry);
            } catch (error) {
                console.error('[MemoriaChat] Error appending model response to log:', error);
            }
        } else {
            console.error("[MemoriaChat] Log file not found for appending model response:", this.logFilePath);
        }
      }

    } catch (error: any) {
      console.error('[MemoriaChat] Error sending message:', error.message, error.stack);
      loadingMessageEl.remove();
      let errorMessage = 'エラー: メッセージの送信中に問題が発生しました。';
      if (error.message) errorMessage += `\n詳細: ${error.message}`;
      this.appendModelMessage(errorMessage);
      new Notice(`チャットエラー: ${error.message || '不明なエラー'}`);

      if (this.logFilePath) {
        const file = this.app.vault.getFileByPath(this.logFilePath);
        if (file instanceof TFile) {
            const errorLogEntry = `**${this.llmRoleName}**: (エラー発生) ${error.message || '不明なエラー'}\n`;
            try {
                await this.app.vault.append(file, errorLogEntry);
            } catch (logError) {
                console.error('[MemoriaChat] Error appending error to log:', logError);
            }
        } else {
             console.error("[MemoriaChat] Log file not found for appending error message:", this.logFilePath);
        }
      }
    } finally {
      this.scrollToBottom();
    }
  }
}
