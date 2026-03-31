/**
 * LLM呼び出しの抽象化。
 * テキスト生成とエンベディング生成の2つのプリミティブのみを提供する。
 */
export interface LLMAdapter {
  /**
   * テキスト生成。プロンプトを送ってテキスト応答を得る。
   * @param prompt プロンプト文字列
   * @param options 生成オプション
   * @returns 生成されたテキスト
   */
  generate(prompt: string, options?: LLMGenerateOptions): Promise<string>;

  /**
   * エンベディング生成。テキストをベクトルに変換する。
   * @param text 対象テキスト
   * @returns エンベディングベクトル
   */
  embed(text: string): Promise<number[]>;

  /**
   * LLMが利用可能かどうかを返す。
   */
  isAvailable(): boolean;

  /**
   * エンベディングが利用可能かどうかを返す。
   */
  isEmbeddingAvailable(): boolean;
}

export interface LLMGenerateOptions {
  /** 'main' = 高品質モデル, 'light' = 軽量/高速モデル（要約等） */
  tier?: 'main' | 'light';
  /** 最大出力トークン数 */
  maxTokens?: number;
}
