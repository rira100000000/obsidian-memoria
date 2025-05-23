// src/locationFetcher.ts
import { requestUrl, Notice } from 'obsidian';
import ObsidianMemoria from '../main';
import { GeminiPluginSettings } from './settings';
import { IpLocationInfo, CurrentContextualInfo } from './types';

const IP_API_URL = 'http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query';

/**
 * LocationFetcherクラス
 * IPアドレスに基づいておおよその現在地情報を取得します。
 */
export class LocationFetcher {
  private plugin: ObsidianMemoria;
  private settings: GeminiPluginSettings;

  // 位置情報取得のタイムアウト（ミリ秒）
  private readonly FETCH_TIMEOUT = 5000; // 5秒

  // 前回取得時刻とキャッシュされた情報
  private lastFetchedTime: number | null = null;
  private cachedLocationInfo: IpLocationInfo | null = null;
  // キャッシュの有効期間（ミリ秒）例: 1時間
  private readonly CACHE_DURATION = 60 * 60 * 1000;


  constructor(plugin: ObsidianMemoria) {
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  /**
   * 現在のIPアドレスからおおよその位置情報を取得します。
   * レート制限を考慮し、短期間に複数回呼び出された場合はキャッシュされた情報を返すことがあります。
   * @returns {Promise<IpLocationInfo | null>} 取得した位置情報、またはエラー時はnull。
   */
  public async fetchCurrentIpLocation(): Promise<IpLocationInfo | null> {
    const now = Date.now();

    // キャッシュが有効であればキャッシュを返す
    if (this.cachedLocationInfo && this.lastFetchedTime && (now - this.lastFetchedTime < this.CACHE_DURATION)) {
      console.log('[LocationFetcher] Returning cached IP location info.');
      return this.cachedLocationInfo;
    }

    try {
      console.log(`[LocationFetcher] Fetching IP location from ${IP_API_URL}`);
      const response = await requestUrl({
        url: IP_API_URL,
        method: 'GET',
        // ObsidianのrequestUrlはデフォルトでタイムアウトがないため、
        // AbortControllerを使って自前でタイムアウト処理を実装する
      });
      
      // AbortControllerでタイムアウトを実装する例（requestUrlがAbortSignalをサポートしている場合）
      // const controller = new AbortController();
      // const timeoutId = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT);

      // const response = await requestUrl({
      //   url: IP_API_URL,
      //   method: 'GET',
      //   // signal: controller.signal, // requestUrlが対応していれば
      // });
      // clearTimeout(timeoutId);


      if (response.status !== 200) {
        console.error(`[LocationFetcher] Error fetching IP location. Status: ${response.status}, Text: ${response.text}`);
        new Notice(`位置情報取得エラー: サーバーから予期しない応答がありました (ステータス ${response.status})。`);
        return null;
      }

      const locationData = response.json as IpLocationInfo;

      if (locationData.status === 'success') {
        console.log('[LocationFetcher] Successfully fetched IP location:', locationData);
        this.cachedLocationInfo = locationData;
        this.lastFetchedTime = now;
        return locationData;
      } else {
        console.error(`[LocationFetcher] API returned status 'fail': ${locationData.message}`);
        new Notice(`位置情報取得失敗: ${locationData.message || '不明なエラー'}`);
        // statusがfailの場合はキャッシュしない、またはエラー情報をキャッシュする
        this.cachedLocationInfo = locationData; // エラー情報も一時的にキャッシュする
        this.lastFetchedTime = now; // 次回のリクエストのために時刻は更新
        return locationData; // エラー情報を含むオブジェクトを返す
      }
    } catch (error: any) {
      // ネットワークエラーやタイムアウト（手動実装の場合）など
      if (error.name === 'AbortError') {
        console.error('[LocationFetcher] IP location fetch timed out.');
        new Notice('位置情報取得タイムアウト。');
      } else {
        console.error('[LocationFetcher] Error fetching IP location:', error.message, error.stack);
        new Notice(`位置情報取得中にネットワークエラーが発生しました: ${error.message}`);
      }
      // エラー発生時はキャッシュをクリアするか、古いキャッシュを維持するか選択
      // ここではnullを返し、キャッシュは更新しない（次回再試行を促す）
      this.cachedLocationInfo = null; 
      return null;
    }
  }

  /**
   * 取得したIpLocationInfoを、LLMに渡しやすい形式 (CurrentContextualInfoの一部) に整形します。
   * @param ipInfo {IpLocationInfo | null} ip-api.com から取得した情報。
   * @returns {CurrentContextualInfo['location']} 整形された位置情報、またはエラー時はundefined。
   */
  public formatIpLocationForContext(ipInfo: IpLocationInfo | null): CurrentContextualInfo['location'] | undefined {
    if (!ipInfo || ipInfo.status !== 'success') {
      return undefined;
    }

    return {
      city: ipInfo.city,
      regionName: ipInfo.regionName,
      country: ipInfo.country,
      latitude: ipInfo.lat,
      longitude: ipInfo.lon,
      timezone: ipInfo.timezone,
    };
  }

  /**
   * このモジュールが使用する外部サービスの帰属情報を返します。
   * @returns {CurrentContextualInfo['attribution']} 帰属情報オブジェクト。
   */
  public getAttributionInfo(): CurrentContextualInfo['attribution'] {
    return {
      locationService: 'ip-api.com (http://ip-api.com/)',
    };
  }
}
