// src/locationFetcher.ts
import { requestUrl, Notice, moment } from 'obsidian';
import ObsidianMemoria from '../main';
import { GeminiPluginSettings } from './settings';
import { IpLocationInfo, WeatherInfo, CurrentContextualInfo, OpenMeteoCurrentWeather } from './types';

const IP_API_URL = 'http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query';
const OPEN_METEO_API_URL = 'https://api.open-meteo.com/v1/forecast';

const WMO_WEATHER_DESCRIPTIONS: { [key: number]: string } = {
  0: '快晴',
  1: '概ね晴れ',
  2: '部分的に曇り',
  3: '曇り',
  45: '霧',
  48: '霧氷',
  51: '霧雨（弱）',
  53: '霧雨',
  55: '霧雨（強）',
  56: '凍える霧雨（弱）',
  57: '凍える霧雨（強）',
  61: '雨（弱）',
  63: '雨',
  65: '雨（強）',
  66: '凍える雨（弱）',
  67: '凍える雨（強）',
  71: '雪（弱）',
  73: '雪',
  75: '雪（強）',
  77: '霧雪',
  80: 'にわか雨（弱）',
  81: 'にわか雨',
  82: 'にわか雨（強）',
  85: 'にわか雪（弱）',
  86: 'にわか雪（強）',
  95: '雷雨',
  96: '雷雨（雹を伴う）',
  99: '雷雨（激しい雹を伴う）'
};

export class LocationFetcher {
  private plugin: ObsidianMemoria;
  private settings: GeminiPluginSettings;

  private readonly FETCH_TIMEOUT = 7000;
  private lastIpLocationFetchedTime: number | null = null;
  private cachedIpLocationInfo: IpLocationInfo | null = null;
  private readonly IP_CACHE_DURATION = 60 * 60 * 1000; // 1時間

  private lastWeatherFetchedTime: number | null = null;
  private cachedWeatherInfo: WeatherInfo | null = null;
  private lastWeatherFetchCoords: { lat: number; lon: number } | null = null;
  private readonly WEATHER_CACHE_DURATION = 15 * 60 * 1000; // 15分

  constructor(plugin: ObsidianMemoria) {
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  /**
   * プラグインの設定が変更されたときに呼び出されます。
   * 内部のsettingsプロパティを更新します。
   * @param newSettings 新しい GeminiPluginSettings オブジェクト。
   */
  public onSettingsChanged(newSettings: GeminiPluginSettings): void {
    this.settings = newSettings;
    console.log('[LocationFetcher] Settings updated.');
    // 必要に応じてキャッシュをクリアするなどの処理を追加できます
    // 例: this.cachedIpLocationInfo = null; this.cachedWeatherInfo = null;
  }

  private async fetchCurrentIpLocationInternal(): Promise<IpLocationInfo | null> {
    const now = Date.now();
    if (this.cachedIpLocationInfo && this.lastIpLocationFetchedTime && (now - this.lastIpLocationFetchedTime < this.IP_CACHE_DURATION)) {
      console.log('[LocationFetcher] Returning cached IP location info.');
      return this.cachedIpLocationInfo;
    }

    try {
      console.log(`[LocationFetcher] Fetching IP location from ${IP_API_URL}`);
      const response = await requestUrl({ url: IP_API_URL, method: 'GET' });

      if (response.status !== 200) {
        console.error(`[LocationFetcher] Error fetching IP location. Status: ${response.status}, Text: ${response.text}`);
        return null;
      }
      const locationData = response.json as IpLocationInfo;
      if (locationData.status === 'success') {
        this.cachedIpLocationInfo = locationData;
        this.lastIpLocationFetchedTime = now;
        return locationData;
      } else {
        console.error(`[LocationFetcher] IP API returned status 'fail': ${locationData.message}`);
        this.cachedIpLocationInfo = locationData;
        this.lastIpLocationFetchedTime = now;
        return locationData;
      }
    } catch (error: any) {
      console.error('[LocationFetcher] Network error fetching IP location:', error.message);
      this.cachedIpLocationInfo = null;
      return null;
    }
  }

  private async fetchCurrentWeatherInternal(latitude: number, longitude: number, timezone: string): Promise<WeatherInfo | null> {
    const now = Date.now();
    if (
      this.cachedWeatherInfo &&
      this.lastWeatherFetchedTime &&
      this.lastWeatherFetchCoords?.lat === latitude &&
      this.lastWeatherFetchCoords?.lon === longitude &&
      (now - this.lastWeatherFetchedTime < this.WEATHER_CACHE_DURATION)
    ) {
      console.log('[LocationFetcher] Returning cached weather info.');
      return this.cachedWeatherInfo;
    }

    const params = new URLSearchParams({
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m',
      timezone: timezone || 'auto',
      forecast_days: '1'
    });
    const url = `${OPEN_METEO_API_URL}?${params.toString()}`;

    try {
      console.log(`[LocationFetcher] Fetching weather data from ${url}`);
      const response = await requestUrl({ url, method: 'GET' });

      if (response.status !== 200) {
        console.error(`[LocationFetcher] Error fetching weather data. Status: ${response.status}, Text: ${response.text}`);
        return null;
      }
      const weatherData = response.json as WeatherInfo;
      if (weatherData && weatherData.current) {
        this.cachedWeatherInfo = weatherData;
        this.lastWeatherFetchedTime = now;
        this.lastWeatherFetchCoords = { lat: latitude, lon: longitude };
        return weatherData;
      } else {
        console.error('[LocationFetcher] Weather API response missing current weather data:', weatherData);
        return null;
      }
    } catch (error: any) {
      console.error('[LocationFetcher] Network error fetching weather data:', error.message);
      this.cachedWeatherInfo = null;
      return null;
    }
  }

  private getWeatherDescription(weatherCode: number | undefined): string {
    if (weatherCode === undefined) return '天気情報なし';
    return WMO_WEATHER_DESCRIPTIONS[weatherCode] || `不明な天気コード (${weatherCode})`;
  }

  public async fetchCurrentContextualInfo(): Promise<CurrentContextualInfo | null> {
    const ipInfo = await this.fetchCurrentIpLocationInternal();
    const contextualInfo: CurrentContextualInfo = {
      attribution: this.getAttributionInfo()
    };

    if (!ipInfo || ipInfo.status !== 'success' || ipInfo.lat === undefined || ipInfo.lon === undefined) {
      contextualInfo.error = ipInfo?.message || 'IPベースの位置情報の取得に失敗しました。';
      new Notice(contextualInfo.error);
      return contextualInfo;
    }

    contextualInfo.location = {
      city: ipInfo.city,
      regionName: ipInfo.regionName,
      country: ipInfo.country,
      latitude: ipInfo.lat,
      longitude: ipInfo.lon,
      timezone: ipInfo.timezone,
    };

    const weatherInfo = await this.fetchCurrentWeatherInternal(ipInfo.lat, ipInfo.lon, ipInfo.timezone || 'auto');

    if (weatherInfo && weatherInfo.current) {
      const currentW = weatherInfo.current;
      contextualInfo.weather = {
        temperature: currentW.temperature_2m,
        description: this.getWeatherDescription(currentW.weather_code),
        windspeed: currentW.wind_speed_10m,
        time: currentW.time ? moment(currentW.time).format('YYYY-MM-DD HH:mm') : undefined,
        humidity: currentW.relative_humidity_2m,
        apparent_temperature: currentW.apparent_temperature,
      };
    } else {
      const weatherError = '天気情報の取得に失敗しました。';
      if (contextualInfo.error) {
        contextualInfo.error += ` ${weatherError}`;
      } else {
        contextualInfo.error = weatherError;
      }
      new Notice(weatherError);
    }
    return contextualInfo;
  }

  public getAttributionInfo(): CurrentContextualInfo['attribution'] {
    return {
      locationService: 'ip-api.com (http://ip-api.com/)',
      weatherService: 'Open-Meteo.com (https://open-meteo.com/) - CC BY 4.0',
    };
  }
}
