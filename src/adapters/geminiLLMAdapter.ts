import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { HumanMessage } from "@langchain/core/messages";
import { LLMAdapter, LLMGenerateOptions } from '../core/interfaces/llmAdapter';
import { FileLogger } from '../utils/fileLogger';

export interface GeminiLLMAdapterConfig {
  apiKey: string;
  mainModel: string;
  lightModel?: string;
  embeddingModel?: string;
}

export class GeminiLLMAdapter implements LLMAdapter {
  private mainLlm: ChatGoogleGenerativeAI | null = null;
  private lightLlm: ChatGoogleGenerativeAI | null = null;
  private genAI: GoogleGenerativeAI | null = null;
  private embeddingModelName: string;
  private config: GeminiLLMAdapterConfig;
  private fileLogger: FileLogger | null = null;
  /** generate() 呼び出しにラベルを付与するためのコンテキスト（呼び出し元が設定） */
  private nextCallLabel: string | null = null;

  constructor(config: GeminiLLMAdapterConfig) {
    this.config = config;
    this.embeddingModelName = config.embeddingModel || 'gemini-embedding-001';
    this.initialize();
  }

  setFileLogger(logger: FileLogger): void {
    this.fileLogger = logger;
  }

  /**
   * 次のgenerate()呼び出しに付与するラベルを設定する。
   * ラベルは1回の呼び出し後に自動的にクリアされる。
   */
  setNextCallLabel(label: string): void {
    this.nextCallLabel = label;
  }

  private initialize(): void {
    if (!this.config.apiKey) {
      console.warn("[GeminiLLMAdapter] API key not set. LLM not initialized.");
      return;
    }

    try {
      this.mainLlm = new ChatGoogleGenerativeAI({
        apiKey: this.config.apiKey,
        model: this.config.mainModel,
      });
      this.lightLlm = new ChatGoogleGenerativeAI({
        apiKey: this.config.apiKey,
        model: this.config.lightModel || this.config.mainModel,
      });
      this.genAI = new GoogleGenerativeAI(this.config.apiKey);
      console.log(`[GeminiLLMAdapter] Initialized. Main: ${this.config.mainModel}, Light: ${this.config.lightModel || this.config.mainModel}, Embedding: ${this.embeddingModelName}`);
    } catch (e: any) {
      console.error("[GeminiLLMAdapter] Failed to initialize:", e.message);
      this.mainLlm = null;
      this.lightLlm = null;
      this.genAI = null;
    }
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<string> {
    const llm = options?.tier === 'light' ? this.lightLlm : this.mainLlm;
    if (!llm) {
      throw new Error("LLM not initialized. Check API key and model settings.");
    }
    const callLabel = this.nextCallLabel || 'unknown';
    this.nextCallLabel = null;

    const response = await llm.invoke([new HumanMessage(prompt)]);
    if (typeof response.content !== 'string') {
      throw new Error('LLM response content is not a string');
    }

    // FileLoggerに記録
    if (this.fileLogger) {
      const metadata: Record<string, any> = {};
      if (response.response_metadata) metadata.response_metadata = response.response_metadata;
      if (response.additional_kwargs && Object.keys(response.additional_kwargs).length > 0) {
        metadata.additional_kwargs = response.additional_kwargs;
      }
      this.fileLogger.logGenerateCall(callLabel, prompt, response.content, {
        tier: options?.tier,
        parseResult: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }

    return response.content;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.genAI) {
      throw new Error("Embedding client not initialized. Check API key.");
    }
    const model = this.genAI.getGenerativeModel(
      { model: this.embeddingModelName },
      { apiVersion: 'v1beta' }
    );
    const result = await model.embedContent(text);
    return result.embedding.values;
  }

  isAvailable(): boolean {
    return this.mainLlm !== null;
  }

  isEmbeddingAvailable(): boolean {
    return this.genAI !== null;
  }

  /**
   * 設定変更時に再初期化する。
   */
  updateConfig(config: GeminiLLMAdapterConfig): void {
    this.config = config;
    this.embeddingModelName = config.embeddingModel || 'gemini-embedding-001';
    this.mainLlm = null;
    this.lightLlm = null;
    this.genAI = null;
    this.initialize();
  }
}
