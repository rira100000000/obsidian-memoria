// src/ui/chatWindow.ts
import { ItemView, WorkspaceLeaf, Notice, moment, TFile, App } from 'obsidian';
import ObsidianMemoria from '../../main';
import { GeminiPluginSettings, DEFAULT_SETTINGS } from '../settings';
import {
  ChatGoogleGenerativeAI,
  GoogleGenerativeAIChatCallOptions,
} from "@langchain/google-genai";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  BaseMessage,
  ToolMessage,
  AIMessageChunk,
} from "@langchain/core/messages";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate
} from "@langchain/core/prompts";

import { TagProfiler } from '../tagProfiler';
import { ContextRetriever } from '../contextRetriever';
import { LocationFetcher } from '../locationFetcher';
import { ChatLogger } from '../chatLogger';
import { ChatUIManager } from './chatUIManager';
import { ChatSessionManager } from '../chatSessionManager';
import { PromptFormatter } from '../promptFormatter';
import { ChatContextBuilder, LlmContextInput } from '../chatContextBuilder';
import { ToolManager } from '../tools/toolManager';
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export const CHAT_VIEW_TYPE = 'obsidian-memoria-chat-view';

export class ChatView extends ItemView {
  plugin: ObsidianMemoria;
  settings: GeminiPluginSettings;
  private uiManager!: ChatUIManager;
  private chatSessionManager!: ChatSessionManager;
  private promptFormatter!: PromptFormatter;
  private chatContextBuilder!: ChatContextBuilder;
  private toolManager!: ToolManager;

  private chatModel: ChatGoogleGenerativeAI | null = null;
  private contextRetriever: ContextRetriever;
  private locationFetcher: LocationFetcher;
  private chatLogger!: ChatLogger;

  private llmRoleName: string;
  private tagProfiler: TagProfiler;
  private viewInstanceId: string;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianMemoria) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;
    this.viewInstanceId = Math.random().toString(36).substring(2, 8);
    console.log(`[ChatView][${this.viewInstanceId}] Constructor called. Initial RoleName: ${this.llmRoleName}`);

    this.tagProfiler = new TagProfiler(this.plugin);
    this.contextRetriever = new ContextRetriever(this.plugin);
    this.locationFetcher = plugin.locationFetcher;
    this.promptFormatter = new PromptFormatter(this.settings);
    this.chatContextBuilder = new ChatContextBuilder(
        this.contextRetriever,
        this.locationFetcher,
        this.settings
    );
    this.toolManager = plugin.toolManager;
  }

  private async initializeChatModel() {
    console.log(`[ChatView][${this.viewInstanceId}] initializeChatModel called.`);
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;

    this.promptFormatter.updateSettings(this.settings);
    this.chatContextBuilder.onSettingsChanged(this.settings);

    if (this.settings.geminiApiKey && this.settings.geminiModel) {
      try {
        this.chatModel = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: this.settings.geminiModel,
        });
        console.log(`[ChatView][${this.viewInstanceId}] Chat model initialized. LLM Role: ${this.llmRoleName}`);
      } catch (error: any) {
        console.error(`[ChatView][${this.viewInstanceId}] Failed to initialize ChatGoogleGenerativeAI model:`, error.message);
        new Notice('Geminiモデルの初期化に失敗しました。');
        this.chatModel = null;
      }
    } else {
      console.log(`[ChatView][${this.viewInstanceId}] API key or model name not set. Chat model not initialized.`);
      this.chatModel = null;
    }
  }

  onSettingsChanged() {
    console.log(`[ChatView][${this.viewInstanceId}] onSettingsChanged called.`);
    const oldRoleName = this.llmRoleName;
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;
    console.log(`[ChatView][${this.viewInstanceId}] RoleName changed from '${oldRoleName}' to '${this.llmRoleName}'`);

    if (this.chatLogger) this.chatLogger = new ChatLogger(this.app, this.llmRoleName);
    if (this.chatSessionManager) {
        this.chatSessionManager.updateLlmRoleName(this.llmRoleName);
        if (this.chatLogger) this.chatSessionManager.updateChatLogger(this.chatLogger);
    }
    
    this.initializeChatModel();
    this.tagProfiler.onSettingsChanged();
    this.contextRetriever.onSettingsChanged();
    this.chatContextBuilder.onSettingsChanged(this.settings);
    if (this.toolManager) this.toolManager.onSettingsChanged();

    this.updateTitle();
    console.log(`[ChatView][${this.viewInstanceId}] Settings changed, relevant modules re-initialized/updated.`);
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return `Memoria Chat (${this.llmRoleName || '...'})`; }
  getIcon() { return 'messages-square'; }

  async onOpen() {
    console.log(`[ChatView][${this.viewInstanceId}] onOpen called.`);
    this.settings = this.plugin.settings;
    this.llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;

    this.chatLogger = new ChatLogger(this.app, this.llmRoleName);
    this.toolManager = this.plugin.toolManager;

    this.promptFormatter.updateSettings(this.settings);
    this.chatContextBuilder.onSettingsChanged(this.settings);
    this.contextRetriever.onSettingsChanged();
    this.tagProfiler.onSettingsChanged();
    this.toolManager.onSettingsChanged();

    this.uiManager = new ChatUIManager(
        this.containerEl.children[1] as HTMLElement,
        () => this.sendMessage(),
        () => this.chatSessionManager.resetChat(false),
        () => this.chatSessionManager.confirmAndDiscardChat()
    );

    this.chatSessionManager = new ChatSessionManager(
        this.app,
        this.plugin,
        this.uiManager,
        this.chatLogger,
        this.tagProfiler,
        this.llmRoleName
    );

    await this.initializeChatModel(); 

    this.uiManager.appendModelMessage(`チャットウィンドウへようこそ！ ${this.llmRoleName}がお話しします。\nShift+Enterでメッセージを送信します。`);

    if (!this.chatModel) {
        new Notice('チャットモデルの接続に問題がある可能性があります。設定を確認してください。', 0);
    } else if (!this.settings.geminiApiKey || !this.settings.geminiModel) {
        new Notice('Geminiチャット機能が利用できません。設定（APIキー、モデル名）を確認してください。', 0);
    }
    this.updateTitle();
  }

  async onClose() {
    console.log(`[ChatView][${this.viewInstanceId}] onClose called.`);
  }

  private updateTitle() {
    const newDisplayText = this.getDisplayText();
    console.log(`[ChatView][${this.viewInstanceId}] updateTitle called. New display text would be: ${newDisplayText}`);
  }

  async sendMessage() {
    console.log(`[ChatView][${this.viewInstanceId}] sendMessage called.`);
    if (!this.chatModel || !this.uiManager || !this.chatSessionManager || !this.promptFormatter || !this.chatContextBuilder || !this.chatLogger || !this.toolManager) {
        console.error(`[ChatView][${this.viewInstanceId}] sendMessage preconditions not met.`);
        new Notice("チャットの送信準備ができていません。");
        return;
    }

    const userInputText = this.uiManager.getInputText().trim();
    if (!userInputText) {
      if (this.uiManager.getInputText().length > 0) new Notice("メッセージが空白です。送信は行いません。");
      this.uiManager.resetInputField();
      return;
    }

    await this.chatSessionManager.addUserMessage(userInputText);
    this.uiManager.appendUserMessage(userInputText);
    await this.chatLogger.appendLogEntry(`**User**: ${userInputText}\n`);
    this.uiManager.resetInputField();

    // 初期ローディングメッセージ要素
    const initialLoadingMessageEl = this.uiManager.appendMessage('応答を待っています...', 'loading');
    // ストリーミングや最終応答を表示するためのUI要素を管理する変数
    let currentMessageDisplayElement: HTMLElement | null = initialLoadingMessageEl;

    try {
        let currentMessages: BaseMessage[] = await this.chatSessionManager.getMessages();
        const isFirstActualUserMessage = currentMessages.filter(msg => msg._getType() === "human").length === 1;

        let currentLogPath = this.chatLogger.getLogFilePath();
        if (!currentLogPath) {
            await this.chatLogger.setupLogFile(this.llmRoleName);
            currentLogPath = this.chatLogger.getLogFilePath();
            if (!currentLogPath) {
                this.uiManager.appendModelMessage('エラー: ログファイルの作成に失敗したため、メッセージを送信できません。');
                new Notice('ログファイルの作成に失敗しました。');
                if (currentMessageDisplayElement && currentMessageDisplayElement.parentNode) currentMessageDisplayElement.remove();
                return;
            }
        }

        const llmContext = await this.chatContextBuilder.prepareContextForLlm(
            userInputText,
            this.llmRoleName,
            currentMessages,
            isFirstActualUserMessage
        );
         if (isFirstActualUserMessage) {
            if (this.settings.showLocationInChat && llmContext.current_location_string && !llmContext.current_location_string.includes("失敗") && !llmContext.current_location_string.includes("最初のメッセージでのみ")) {
                new Notice(`現在地情報がLLMに渡されました。`, 3000);
            }
            if (this.settings.showWeatherInChat && llmContext.current_weather_string && !llmContext.current_weather_string.includes("失敗") && !llmContext.current_weather_string.includes("最初のメッセージでのみ")) {
                new Notice(`天気情報がLLMに渡されました。`, 3000);
            }
        }

        const systemPromptStr = this.promptFormatter.getSystemPromptTemplate()
            .replace('{character_setting_prompt}', llmContext.character_setting_prompt)
            .replace('{current_time}', llmContext.current_time)
            .replace('{current_location_string}', llmContext.current_location_string)
            .replace('{current_weather_string}', llmContext.current_weather_string)
            .replace('{retrieved_context_string}', llmContext.retrieved_context_string)
            .replace('{input}', userInputText);

        const messagesForLlm: BaseMessage[] = [
            new SystemMessage(systemPromptStr),
            ...currentMessages
        ];
        
        const toolsOption: StructuredTool<z.ZodObject<any, any, any, any>>[] = this.toolManager.getLangchainTools();
        let aiResponse: AIMessage;
        let combinedContentFromStream = "";
        let firstChunkReceived = false;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            console.log(`[ChatView][${this.viewInstanceId}] Invoking LLM. Message count: ${messagesForLlm.length}. Tools provided: ${toolsOption.length}`);
            
            let accumulatedChunk: AIMessageChunk | null = null;
            combinedContentFromStream = ""; 

            // ストリーム開始前に、現在の表示要素を準備
            if (currentMessageDisplayElement && currentMessageDisplayElement.parentNode && currentMessageDisplayElement.classList.contains('loading')) {
                // 初回またはツール実行後のローディングメッセージなら、クリアして再利用
                currentMessageDisplayElement.classList.remove('loading');
                currentMessageDisplayElement.setText('');
            } else if (!currentMessageDisplayElement || !currentMessageDisplayElement.parentNode) {
                // 何らかの理由で表示要素がない場合は新規作成
                currentMessageDisplayElement = this.uiManager.appendMessage('', 'model');
            }
            firstChunkReceived = false;

            const stream = await this.chatModel.stream(messagesForLlm, { tools: toolsOption } as GoogleGenerativeAIChatCallOptions);
            
            for await (const chunk of stream) { 
                if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    // 最初のチャンク受信時に、もし '応答を待っています...' のような初期テキストが残っていればクリア
                    if (currentMessageDisplayElement && currentMessageDisplayElement.textContent === '応答を待っています...') {
                         currentMessageDisplayElement.setText('');
                    }
                }

                const chunkContent = chunk.content;
                if (typeof chunkContent === "string" && chunkContent.length > 0) {
                    combinedContentFromStream += chunkContent; 
                    if (currentMessageDisplayElement) { // currentMessageDisplayElement が null でないことを確認
                        currentMessageDisplayElement.textContent += chunkContent; 
                    }
                    this.uiManager.scrollToBottom();
                }

                if (!accumulatedChunk) {
                    accumulatedChunk = chunk;
                } else {
                    accumulatedChunk = accumulatedChunk.concat(chunk);
                }
            }

            if (!accumulatedChunk && firstChunkReceived) {
                 aiResponse = new AIMessage({content: combinedContentFromStream});
            } else if (!accumulatedChunk && !firstChunkReceived ) {
                 aiResponse = new AIMessage({content: ""}); 
            } else if (accumulatedChunk) {
                 aiResponse = new AIMessage(accumulatedChunk);
            } else {
                 aiResponse = new AIMessage({content: "LLMからの応答が予期せず空でした。"});
            }

            messagesForLlm.push(aiResponse);
            
            if (!aiResponse.tool_calls || aiResponse.tool_calls.length === 0) {
                console.log(`[ChatView][${this.viewInstanceId}] No tool calls from LLM. Final response:`, aiResponse.content);
                break; 
            }

            const currentToolCallsFromLlm = aiResponse.tool_calls;
            console.log(`[ChatView][${this.viewInstanceId}] LLM requested tool calls:`, currentToolCallsFromLlm);
            
            // ツール実行前に、現在のメッセージ表示要素 (ストリーミング途中だったもの) を一旦削除
            if (currentMessageDisplayElement && currentMessageDisplayElement.parentNode) {
                currentMessageDisplayElement.remove();
                currentMessageDisplayElement = null; 
            }
            const toolExecutionNoticeEl = this.uiManager.appendMessage('ツールを実行しています...', 'loading');

            const toolMessages: ToolMessage[] = [];
            for (const toolCall of currentToolCallsFromLlm) {
                const toolName = toolCall.name;
                const toolArgs = toolCall.args;
                const toolCallId = toolCall.id;

                if (!toolName || !toolCallId) {
                    console.error("[ChatView] Invalid tool call structure from LLM:", toolCall);
                    toolMessages.push(new ToolMessage({
                        tool_call_id: toolCallId || `invalid_tool_call_${Date.now()}`,
                        name: toolName || "unknown_tool",
                        content: "Error: Invalid tool call structure received from LLM."
                    }));
                    continue;
                }
                
                const toolToExecute = this.toolManager.getToolByName(toolName);
                if (toolToExecute) {
                    try {
                        console.log(`[ChatView][${this.viewInstanceId}] Executing tool: ${toolName} with args:`, toolArgs);
                        const result = await toolToExecute.invoke(toolArgs);
                        toolMessages.push(new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: result 
                        }));
                        console.log(`[ChatView][${this.viewInstanceId}] Tool ${toolName} executed. Result:`, result);
                        // ツール実行結果をUIに表示 (オプション)
                        this.uiManager.appendModelMessage(`ツール「${toolName}」を実行しました。結果:\n${String(result).substring(0,150)}...`);

                    } catch (toolError: any) {
                        console.error(`[ChatView][${this.viewInstanceId}] Error executing tool ${toolName}:`, toolError);
                        toolMessages.push(new ToolMessage({
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: `Error executing tool: ${toolError.message}`
                        }));
                    }
                } else {
                    console.warn(`[ChatView][${this.viewInstanceId}] Unknown tool called: ${toolName}`);
                    toolMessages.push(new ToolMessage({
                        tool_call_id: toolCallId,
                        name: toolName,
                        content: `Error: Unknown tool ${toolName}`
                    }));
                }
            }
            if (toolExecutionNoticeEl && toolExecutionNoticeEl.parentNode) toolExecutionNoticeEl.remove();
            messagesForLlm.push(...toolMessages);
            
            // 次のLLM呼び出しのために、新しいローディングメッセージ要素を準備
            currentMessageDisplayElement = this.uiManager.appendMessage('LLMの応答を待っています...', 'loading');
            firstChunkReceived = false; // リセット
        } // End of while(true) loop

        const finalContentToDisplay = typeof aiResponse.content === 'string' ? aiResponse.content : combinedContentFromStream;

        if (finalContentToDisplay || firstChunkReceived) { 
            if (currentMessageDisplayElement && currentMessageDisplayElement.parentNode) {
                // currentMessageDisplayElement がローディング状態なら、最終テキストで更新
                if (currentMessageDisplayElement.classList.contains('loading')) {
                    currentMessageDisplayElement.classList.remove('loading');
                    currentMessageDisplayElement.setText(finalContentToDisplay || "(空の応答)");
                } else if (currentMessageDisplayElement.textContent !== finalContentToDisplay) {
                    // 既にテキストが表示されていて、最終結果と異なる場合のみ更新
                    // (ストリーミングで表示済みで、ツール呼び出しがなかった場合はここを通らない)
                    currentMessageDisplayElement.setText(finalContentToDisplay || "(空の応答)");
                }
            } else { 
                // currentMessageDisplayElement が何らかの理由で存在しない場合 (ツール実行後に再作成されなかった等)
                // または、initialLoadingMessageEl が currentMessageDisplayElement だったが削除された場合
                this.uiManager.appendModelMessage(finalContentToDisplay || "(空の応答)");
            }

            await this.chatSessionManager.addAiMessage(finalContentToDisplay);
            await this.chatLogger.appendLogEntry(`**${this.llmRoleName}**: ${finalContentToDisplay}\n`);
        } else { 
            // ストリームも開始されず、最終コンテンツもない場合
            if (initialLoadingMessageEl && initialLoadingMessageEl.parentNode) { // sendMessage冒頭のローディングを削除
                 initialLoadingMessageEl.remove();
            }
            // currentMessageDisplayElement が initialLoadingMessageEl と同じで、既に削除されている場合は何もしない
            this.uiManager.appendModelMessage('エラー: LLMからの応答がありませんでした。');
            await this.chatLogger.appendLogEntry(`**${this.llmRoleName}**: (応答なし)\n`);
        }

    } catch (error: any) {
        console.error(`[ChatView][${this.viewInstanceId}] Error sending message or processing tools:`, error.message, error.stack);
        // エラー発生時は、表示されている可能性のあるメッセージ要素をクリーンアップ
        if (initialLoadingMessageEl && initialLoadingMessageEl.parentNode) initialLoadingMessageEl.remove();
        if (currentMessageDisplayElement && currentMessageDisplayElement !== initialLoadingMessageEl && currentMessageDisplayElement.parentNode) {
            currentMessageDisplayElement.remove();
        }
        let errorMessage = 'エラー: メッセージの送信またはツール処理中に問題が発生しました。';
        if (error.message) errorMessage += `\n詳細: ${error.message}`;
        this.uiManager.appendModelMessage(errorMessage);
        new Notice(`チャットエラー: ${error.message || '不明なエラー'}`);
        await this.chatLogger.appendLogEntry(`**${this.llmRoleName}**: (エラー発生) ${error.message || '不明なエラー'}\n`);
    } finally {
        this.uiManager.scrollToBottom();
    }
  }
}
