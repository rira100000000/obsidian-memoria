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
  full_log: string; // "[[YYYYMMDDHHmmss.md]]" または "YYYYMMDDHHmmss.md" または "YYYYMMDDHHmmss"
  mood?: string;
  key_takeaways?: string[];
  action_items?: string[];
  // 他にもsummaryGenerator.tsで定義されているフィールドがある想定
}

// --- ContextRetriever で使用する型定義 ---
export interface RetrievedContextItem {
  sourceType: 'TPN' | 'SN' | 'FullLog';
  sourceName: string; // ファイル名 (拡張子なし)
  contentSnippet: string;
  relevance?: number;
  title?: string;
  date?: string; // YYYY-MM-DD HH:MM 形式
}

export interface RetrievedContext {
  originalPrompt: string;
  identifiedKeywords: Array<{ keyword: string; inPromptScore: number; finalScore?: number; correspondingTag?: string }>;
  retrievedItems: RetrievedContextItem[];
  llmContextPrompt: string;
  nextSnToFetch?: string[];
  nextFlToFetch?: string;
  llmEvaluationResponse?: string;
}

export interface LlmContextEvaluationResponse {
  sufficient_for_response: boolean;
  reasoning?: string;
  next_summary_notes_to_fetch?: string[];
  requires_full_log_for_summary_note?: string;
}

// --- LocationFetcher で使用する型定義 ---

/**
 * ip-api.com から返されるJSONレスポンスの型定義。
 * 詳細は http://ip-api.com/docs/api:json を参照。
 */
export interface IpLocationInfo {
  status: 'success' | 'fail';
  message?: string; // statusがfailの場合に存在
  country?: string;
  countryCode?: string;
  region?: string;
  regionName?: string;
  city?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
  query?: string; // 送信されたIPアドレス
}

/**
 * Open-Meteo APIから返される現在の天気情報の型。
 * https://open-meteo.com/en/docs#current=temperature_2m,weather_code,wind_speed_10m
 */
export interface OpenMeteoCurrentWeather {
  time: string; // ISO8601 format e.g., "2023-10-27T15:00"
  interval: number; // Interval in seconds (e.g., 900 for 15 minutes)
  temperature_2m?: number; // Air temperature at 2 meters above ground
  relative_humidity_2m?: number; // Relative humidity at 2 meters above ground
  apparent_temperature?: number; // Apparent temperature
  is_day?: 0 | 1; // 1 if it is day, 0 if it is night
  precipitation?: number; // Sum of precipitation (rain, showers, snow) in the last hour in mm
  rain?: number;
  showers?: number;
  snowfall?: number;
  weather_code?: number; // WMO Weather interpretation code
  cloud_cover?: number; // Percentage
  pressure_msl?: number; // Sea level pressure
  surface_pressure?: number;
  wind_speed_10m?: number; // Wind speed at 10 meters above ground
  wind_direction_10m?: number; // Wind direction at 10 meters above ground
  wind_gusts_10m?: number; // Wind gusts at 10 meters above ground
}

/**
 * Open-Meteo APIのレスポンス全体の型。
 */
export interface WeatherInfo {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string; // e.g., "Asia/Tokyo"
  timezone_abbreviation: string; // e.g., "JST"
  elevation: number;
  current?: OpenMeteoCurrentWeather; // current_weatherがOpenMeteoのドキュメントではcurrentに変わったため合わせる
  // current_weather?: OpenMeteoCurrentWeather; // 古いAPI仕様の場合
}


/**
 * LocationFetcherが返す、整形された位置情報と天気情報。
 */
export interface CurrentContextualInfo {
  location?: {
    city?: string;
    regionName?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
    timezone?: string;
  };
  weather?: {
    temperature?: number;
    description?: string; // 天気コードから変換した説明
    windspeed?: number;
    time?: string; // 天気情報の取得時刻
    humidity?: number;
    apparent_temperature?: number;
  };
  error?: string; // エラーが発生した場合のメッセージ
  attribution?: { // API利用の帰属表示
    locationService?: string;
    weatherService?: string;
  }
}

/**
 * TODOアイテムの型定義
 */
export interface TodoItem {
  task: string;
  completed: boolean;
  dueDate?: string;
  priority?: string;
  raw: string; // 元のMarkdown行
}

// TodoToolInput と TodoActionParams は Zod スキーマから型推論されるため、
// src/tools/todoTool.ts 内で z.infer を使って定義されます。
// もし他の場所でこれらの型が必要な場合は、todoTool.ts からエクスポートしてインポートします。
// 例: export type TodoToolInput = z.infer<typeof TodoToolInputSchema>; in todoTool.ts
//     import { TodoToolInput } from './tools/todoTool'; else where
