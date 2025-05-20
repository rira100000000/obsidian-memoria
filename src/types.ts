// src/types.ts

/**
 * tag_scores.json の各タグエントリの型定義
 */
export interface TagScoreEntry {
  base_importance: number; // タグの基本重要度 (0-100)
  last_mentioned_in: string; // 最後に言及されたSummaryNoteへのリンク "[[SN-YYYYMMDDHHMM-TopicX]]"
  mention_frequency: number; // このタグが登場したSummaryNoteの数
}

/**
 * tag_scores.json 全体の型定義
 * キーはタグ名
 */
export interface TagScores {
  [tagName: string]: TagScoreEntry;
}

/**
 * TagProfilingNote (TPN-<TagName>.md) のフロントマターの型定義
 */
export interface TagProfilingNoteFrontmatter {
  tag_name: string; // タグ名
  aliases?: string[]; // タグの別名や関連語
  type: 'tag_profile'; // ノートタイプ (固定)
  created_date: string; // 作成日時 (YYYY-MM-DD HH:MM)
  updated_date: string; // 更新日時 (YYYY-MM-DD HH:MM)
  key_themes?: string[]; // このタグに関連する主要テーマや概念
  user_sentiment?: { // このタグに対するユーザーの一般的な感情
    overall: 'Positive' | 'Negative' | 'Neutral' | string; // string は他言語対応のため
    details?: string[]; // 具体的な感情が表れた会話へのリンクやメモ
  };
  master_significance?: string; // このタグがユーザー（マスター）にとって持つ意味や重要性の概要
  related_tags?: string[]; // 関連性の高い他のタグプロファイリングノートへのリンク "[[TPN-RelatedTag1]]"
  summary_notes?: string[]; // このタグが登場したSummaryノートへのリンク (最新のものから順に) "[[SN-YYYYMMDDHHMM-Topic1]]"
  last_mentioned_in?: string; // 最後にこのタグが言及された会話 (tag_scores.json とも連携)
  mention_frequency?: number; // このタグの言及回数 (概算, tag_scores.json とも連携)
}

/**
 * LLMからの応答をパースしたTagProfilingNoteのデータ構造
 */
export interface ParsedLlmTpnData {
  tag_name: string; // TPNの対象となるタグ名
  aliases: string[];
  key_themes: string[];
  user_sentiment_overall: 'Positive' | 'Negative' | 'Neutral' | string;
  user_sentiment_details: string[];
  master_significance: string;
  related_tags: string[];
  // created_date, updated_date, type, summary_notes, last_mentioned_in, mention_frequency は別途処理
  body_overview: string; // 「概要」セクションの本文
  body_contexts: Array<{ summary_note_link: string; context_summary: string }>; // 「これまでの主な文脈」セクションの各項目
  body_user_opinions: Array<{ summary_note_link: string; user_opinion: string }>; // 「ユーザーの意見・反応」セクションの各項目
  body_other_notes: string; // 「その他メモ」セクションの本文
  new_base_importance?: number; // LLMが提案する新しいbase_importance (任意)
}

/**
 * SummaryNoteのフロントマターの型 (関連部分のみ)
 */
export interface SummaryNoteFrontmatter {
  title: string;
  date: string; // YYYY-MM-DD HH:mm:ss
  type: 'conversation_summary';
  participants: string[];
  tags?: string[];
  full_log: string; // "[[YYYYMMDDHHmmss.md]]"
  mood?: string;
  key_takeaways?: string[];
  action_items?: string[];
  // 他にもsummaryGenerator.tsで定義されているフィールドがある想定
}
