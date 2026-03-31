import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { StorageAdapter } from '../core/interfaces/storageAdapter';

export class ObsidianStorageAdapter implements StorageAdapter {
  constructor(private app: App) {}

  async read(path: string): Promise<string> {
    // まず vault.adapter (低レベルAPI) で読む。TFile が不要なケース（JSONファイル等）に対応。
    const exists = await this.app.vault.adapter.exists(path);
    if (!exists) throw new Error(`File not found: ${path}`);

    // Markdownファイルの場合は cachedRead を使って高速に読む
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.app.vault.cachedRead(file);
    }

    // JSONなど非TFileの場合はadapter.readを使う
    return this.app.vault.adapter.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    } else {
      // adapter.exists でファイルが存在するか確認（TFileでないファイル、例: JSON）
      const fileExists = await this.app.vault.adapter.exists(normalized);
      if (fileExists) {
        await this.app.vault.adapter.write(normalized, content);
      } else {
        // 親ディレクトリが存在することを確認
        const parentDir = normalized.substring(0, normalized.lastIndexOf('/'));
        if (parentDir) {
          await this.ensureDir(parentDir);
        }
        await this.app.vault.create(normalized, content);
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    return await this.app.vault.adapter.exists(path);
  }

  async delete(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.delete(file);
    }
  }

  async list(dir: string): Promise<string[]> {
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (folder instanceof TFolder) {
      return folder.children
        .filter((f): f is TFile => f instanceof TFile)
        .map(f => f.path);
    }
    return [];
  }

  async ensureDir(dir: string): Promise<void> {
    const normalized = normalizePath(dir);
    const exists = await this.app.vault.adapter.exists(normalized);
    if (!exists) {
      await this.app.vault.createFolder(normalized);
    }
  }

  async listMarkdownFiles(dir: string): Promise<string[]> {
    return this.app.vault.getMarkdownFiles()
      .filter(f => f.path.startsWith(dir + '/'))
      .map(f => f.path);
  }
}
