import { Notice } from 'obsidian';
import { NotificationAdapter } from '../core/interfaces/notificationAdapter';

export class ObsidianNotificationAdapter implements NotificationAdapter {
  private debugCallback?: (category: string, message: string, data?: string) => void;

  setDebugCallback(cb: (category: string, message: string, data?: string) => void) {
    this.debugCallback = cb;
  }

  info(message: string): void { new Notice(message); }
  warn(message: string): void { new Notice(message); }
  error(message: string): void { new Notice(message, 0); }
  debug(category: string, message: string, data?: string): void {
    this.debugCallback?.(category, message, data);
  }
}
