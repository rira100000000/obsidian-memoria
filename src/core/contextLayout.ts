// src/contextLayout.ts

/**
 * コンテキストウィンドウの割合ベースのレイアウト定義。
 * 各セクションに割り当てるトークン枠の割合を指定する。
 */
export interface ContextLayout {
  system_prompt: number;    // キャラの信念・行動原則
  memory: number;           // TPN/SN からの記憶情報
  narrative: number;        // ここまでの会話要約（ナラティブバッファ）
  working_memory: number;   // 直近Nターンの生会話
  tools_context: number;    // 位置情報・天気・TODO等
}

export const DEFAULT_LAYOUT: ContextLayout = {
  system_prompt: 0.15,
  memory: 0.25,
  narrative: 0.10,
  working_memory: 0.40,
  tools_context: 0.10,
};

/**
 * 各セクションに割り当てられたトークン（文字数）のバジェット。
 */
export interface ContextBudget {
  system_prompt: number;
  memory: number;
  narrative: number;
  working_memory: number;
  tools_context: number;
  total: number;
}

/**
 * 総トークン枠とレイアウト割合から、各セクションのバジェット（文字数）を計算する。
 * @param totalBudget 総文字数バジェット
 * @param layout レイアウト割合定義
 * @returns 各セクションの文字数バジェット
 */
export function calculateBudget(totalBudget: number, layout: ContextLayout = DEFAULT_LAYOUT): ContextBudget {
  return {
    system_prompt: Math.floor(totalBudget * layout.system_prompt),
    memory: Math.floor(totalBudget * layout.memory),
    narrative: Math.floor(totalBudget * layout.narrative),
    working_memory: Math.floor(totalBudget * layout.working_memory),
    tools_context: Math.floor(totalBudget * layout.tools_context),
    total: totalBudget,
  };
}

/**
 * テキストを指定されたバジェット内に収める。
 * バジェットを超える場合は末尾を切り詰める。
 * @param text 対象テキスト
 * @param budget 文字数バジェット
 * @param suffix 切り詰め時に付加するサフィックス
 * @returns バジェット内に収まったテキスト
 */
export function fitWithinBudget(text: string, budget: number, suffix: string = '\n... (省略)'): string {
  if (text.length <= budget) return text;
  return text.substring(0, budget - suffix.length) + suffix;
}
