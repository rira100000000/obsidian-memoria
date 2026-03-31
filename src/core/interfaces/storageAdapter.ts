/**
 * ファイルストレージの抽象化。
 * Obsidian Vault API をラップし、将来的にファイルシステムやDB等に差し替え可能にする。
 */
export interface StorageAdapter {
  /** ファイルの内容を読み取る */
  read(path: string): Promise<string>;

  /** ファイルに内容を書き込む（存在しなければ作成、存在すれば上書き） */
  write(path: string, content: string): Promise<void>;

  /** ファイルが存在するか確認する */
  exists(path: string): Promise<boolean>;

  /** ファイルを削除する */
  delete(path: string): Promise<void>;

  /** ディレクトリ内のファイルパス一覧を取得する */
  list(dir: string): Promise<string[]>;

  /** ディレクトリが存在しなければ作成する */
  ensureDir(dir: string): Promise<void>;

  /** 指定ディレクトリ配下のMarkdownファイル一覧を取得する */
  listMarkdownFiles(dir: string): Promise<string[]>;
}
