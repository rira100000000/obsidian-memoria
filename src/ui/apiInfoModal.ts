// src/ui/apiInfoModal.ts
import { App, Modal, Setting } from 'obsidian';
import { LocationFetcher } from '../locationFetcher'; // パスを修正
import { CurrentContextualInfo } from '../types';

export class ApiInfoModal extends Modal {
  private locationFetcher: LocationFetcher;

  constructor(app: App, locationFetcher: LocationFetcher) {
    super(app);
    this.locationFetcher = locationFetcher;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText('外部API利用情報');

    contentEl.createEl('p', { text: '本プラグインは、機能向上のために以下の外部サービスを利用しています。' });

    const attributionInfo = this.locationFetcher.getAttributionInfo();

    // 位置情報サービス
    contentEl.createEl('h4', { text: '位置情報取得' });
    const locationSection = contentEl.createEl('div', { cls: 'api-info-section' });
    if (attributionInfo?.locationService) {
        const serviceParts = attributionInfo.locationService.match(/^(.*?)\s*\((.*?)\)$/);
        if (serviceParts) {
            locationSection.createEl('p', { text: `サービス名: ${serviceParts[1]}` });
            const urlEl = locationSection.createEl('p');
            urlEl.appendText('公式サイトURL: ');
            const locationLink = urlEl.createEl('a', { text: serviceParts[2], href: serviceParts[2] });
            locationLink.target = '_blank'; // targetプロパティをここで設定
        } else {
            locationSection.createEl('p', { text: `サービス: ${attributionInfo.locationService}` });
        }
    } else {
        const fallbackP = locationSection.createEl('p');
        fallbackP.appendText('ip-api.com (');
        const fallbackLink = fallbackP.createEl('a', { text: 'http://ip-api.com/', href: 'http://ip-api.com/'});
        fallbackLink.target = '_blank'; // targetプロパティをここで設定
        fallbackP.appendText(')');
    }
    locationSection.createEl('p', { text: '利用条件: 非商用無料、レート制限あり。詳細は公式サイトをご確認ください。' });


    // 天気情報サービス
    contentEl.createEl('h4', { text: '天気情報取得' });
    const weatherSection = contentEl.createEl('div', { cls: 'api-info-section' });
    if (attributionInfo?.weatherService) {
        const serviceParts = attributionInfo.weatherService.match(/^(.*?)\s*\((.*?)\)\s*-\s*(.*)$/);
        if (serviceParts) {
            weatherSection.createEl('p', { text: `サービス名: ${serviceParts[1]}` });
            const urlEl = weatherSection.createEl('p');
            urlEl.appendText('公式サイトURL: ');
            const weatherUrlLink = urlEl.createEl('a', { text: serviceParts[2], href: serviceParts[2] });
            weatherUrlLink.target = '_blank'; // targetプロパティをここで設定

            const licenseEl = weatherSection.createEl('p');
            licenseEl.appendText(`ライセンス: `);
            const licenseLinkText = serviceParts[3];
            const licenseActualLink = licenseLinkText.match(/CC BY 4.0/i) ? 'https://creativecommons.org/licenses/by/4.0/' : '#';
            const weatherLicenseLink = licenseEl.createEl('a', { text: licenseLinkText, href: licenseActualLink });
            weatherLicenseLink.target = '_blank'; // targetプロパティをここで設定

            weatherSection.createEl('p', {text: '帰属表示: Weather data by Open-Meteo.com (CC BY 4.0)'});
        } else {
             weatherSection.createEl('p', { text: `サービス: ${attributionInfo.weatherService}` });
        }
    } else {
        const weatherP = weatherSection.createEl('p');
        weatherP.appendText('Open-Meteo.com (');
        const openMeteoLink = weatherP.createEl('a', { text: 'https://open-meteo.com/', href: 'https://open-meteo.com/'});
        openMeteoLink.target = '_blank'; // targetプロパティをここで設定
        weatherP.appendText(') - ');
        const ccByLink = weatherP.createEl('a', { text: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/'});
        ccByLink.target = '_blank'; // targetプロパティをここで設定
        weatherSection.createEl('p', {text: '帰属表示: Weather data by Open-Meteo.com'});
    }
     weatherSection.createEl('p', { text: '利用条件: 非商用無料。詳細は公式サイトをご確認ください。' });


    contentEl.createEl('hr');
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('閉じる')
          .setCta()
          .onClick(() => {
            this.close();
          })
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
