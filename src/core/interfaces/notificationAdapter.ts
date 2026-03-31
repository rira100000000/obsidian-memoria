/**
 * ユーザー通知の抽象化。
 * コアロジックからUI通知を分離する。
 */
export interface NotificationAdapter {
  /** 情報メッセージを表示する */
  info(message: string): void;
  /** 警告メッセージを表示する */
  warn(message: string): void;
  /** エラーメッセージを表示する */
  error(message: string): void;
  /** デバッグログを出力する（UI上のデバッグパネル等） */
  debug(category: string, message: string, data?: string): void;
}
