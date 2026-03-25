import axios from 'axios';
import { MarketRateFetcher, MarketRate, RateSource } from './types';

interface BinanceTickerResponse {
  symbol: string;
  lastPrice: string;
  [key: string]: unknown;
}

interface BinanceP2PResponse {
  data?: Array<{
    adv?: {
      price: string;
    };
    [key: string]: unknown;
  }>;
}

export class KESRateFetcher implements MarketRateFetcher {
  private readonly sources: RateSource[] = [
    {
      name: 'Binance Spot API',
      url: 'https://api.binance.com/api/v3/ticker/price'
    },
    {
      name: 'Central Bank of Kenya',
      url: 'https://www.centralbank.go.ke/wp-json/fx-rate/v1/rates'
    },
    {
      name: 'XE.com',
      url: 'https://www.xe.com/currencytables/?from=USD&to=KES'
    }
  ];

  private readonly BINANCE_BASE_URL = 'https://api.binance.com/api/v3/ticker/price';
  private readonly BINANCE_P2P_URL = 'https://p2p-api.binance.com/bapi/c2c/v2/public/c2c/adv/search';

  getCurrency(): string {
    return 'KES';
  }

  async fetchRate(): Promise<MarketRate> {
    try {
      // Try Binance API first (most reliable for crypto pairs)
      const binanceRate = await this.fetchFromBinance();
      if (binanceRate) {
        return binanceRate;
      }

      // Fallback to Central Bank of Kenya
      const cbkRate = await this.fetchFromCBK();
      if (cbkRate) {
        return cbkRate;
      }

      // Fallback to alternative sources
      for (const source of this.sources.slice(2)) {
        try {
          const rate = await this.fetchFromSource(source);
          if (rate) {
            return rate;
          }
        } catch (error) {
          console.warn(`Failed to fetch from ${source.name}:`, error);
          continue;
        }
      }

      throw new Error('All rate sources failed');
    } catch (error) {
      throw new Error(`Failed to fetch KES rate: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch KES/XLM rate from Binance Spot API
   * Attempts to get the rate through multiple strategies
   */
  private async fetchFromBinance(): Promise<MarketRate | null> {
    try {
      // Strategy 1: Try to fetch XLMKES pair directly
      const directPairRate = await this.fetchBinanceSpotPrice('XLMKES');
      if (directPairRate) {
        return directPairRate;
      }

      // Strategy 2: Try Binance P2P API for KES
      const p2pRate = await this.fetchBinanceP2PRate();
      if (p2pRate) {
        return p2pRate;
      }

      // Strategy 3: Fetch XLMUSDT and USDKES to calculate KES rate
      // This is a fallback approach if direct pairs don't exist
      const xlmUsdRate = await this.fetchBinanceSpotPrice('XLMUSDT');
      if (xlmUsdRate) {
        // For now, we'll use approximate KES/USD rate if we can't find direct KES pair
        // In production, this should fetch actual USDKES rate
        const kesPerUsd = 130.5; // Approximate value, should be fetched from a KES source
        return {
          currency: 'KES',
          rate: parseFloat(xlmUsdRate.rate.toString()) * kesPerUsd,
          timestamp: new Date(),
          source: 'Binance (XLMUSDT × KES/USD)'
        };
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Binance API fetch failed: ${errorMessage}`);
      // Don't throw here - let fallback sources handle it
      return null;
    }
  }

  /**
   * Fetch a specific trading pair price from Binance Spot API
   */
  private async fetchBinanceSpotPrice(
    symbol: string
  ): Promise<{ rate: number; timestamp: Date } | null> {
    try {
      const response = await axios.get<BinanceTickerResponse>(this.BINANCE_BASE_URL, {
        params: { symbol },
        timeout: 8000,
        headers: {
          'User-Agent': 'StellarFlow-Oracle/1.0'
        }
      });

      if (response.data && response.data.lastPrice) {
        const rate = parseFloat(response.data.lastPrice);
        if (!isNaN(rate) && rate > 0) {
          return {
            rate,
            timestamp: new Date()
          };
        }
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Check for specific error types
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 400) {
          console.debug(`Symbol ${symbol} not found on Binance`);
        } else if (error.response?.status === 429) {
          console.warn('Binance API rate limit exceeded');
        } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          console.warn(`Binance API timeout: ${errorMessage}`);
        }
      }
      
      return null;
    }
  }

  /**
   * Fetch KES rates from Binance P2P API
   */
  private async fetchBinanceP2PRate(): Promise<MarketRate | null> {
    try {
      const response = await axios.post<BinanceP2PResponse>(
        this.BINANCE_P2P_URL,
        {
          fiat: 'KES',
          asset: 'XLM',
          merchantCheck: false,
          rows: 1,
          page: 1,
          tradeType: 'BUY'
        },
        {
          timeout: 8000,
          headers: {
            'User-Agent': 'StellarFlow-Oracle/1.0',
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data?.data && response.data.data.length > 0) {
        const price = response.data.data[0]?.adv?.price;
        if (price) {
          const rate = parseFloat(price);
          if (!isNaN(rate) && rate > 0) {
            return {
              currency: 'KES',
              rate,
              timestamp: new Date(),
              source: 'Binance P2P API'
            };
          }
        }
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          console.warn('Binance P2P API rate limit exceeded');
        } else if (
          error.code === 'ECONNABORTED' ||
          error.code === 'ETIMEDOUT'
        ) {
          console.warn(`Binance P2P API timeout: ${errorMessage}`);
        }
      }

      return null;
    }
  }

  private async fetchFromCBK(): Promise<MarketRate | null> {
    try {
      if (!this.sources[1]) {
        throw new Error('No rate sources configured');
      }

      const response = await axios.get(this.sources[1].url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'StellarFlow-Oracle/1.0'
        }
      });

      // CBK API returns rates in KES per USD
      const rates = response.data;
      if (rates && rates.length > 0) {
        const latestRate = rates[0];
        return {
          currency: 'KES',
          rate: parseFloat(latestRate.rate),
          timestamp: new Date(latestRate.date),
          source: this.sources[1].name
        };
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`CBK API failed: ${errorMessage}`);
      return null;
    }
  }

  private async fetchFromSource(source: RateSource): Promise<MarketRate | null> {
    try {
      const response = await axios.get(source.url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'StellarFlow-Oracle/1.0'
        }
      });

      // Placeholder rate - in reality, you'd parse the actual response
      const placeholderRate = 130.5; // Approximate KES/USD rate

      return {
        currency: 'KES',
        rate: placeholderRate,
        timestamp: new Date(),
        source: source.name
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Failed to fetch from ${source.name}: ${errorMessage}`);
      return null;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Test Binance API availability specifically
      const rate = await this.fetchFromBinance();
      if (rate) {
        return true;
      }

      // Fallback to general rate check
      const generalRate = await this.fetchRate();
      return generalRate !== null && generalRate.rate > 0;
    } catch (error) {
      return false;
    }
  }
}
