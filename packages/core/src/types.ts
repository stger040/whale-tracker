export type Platform = 'kalshi' | 'pmus';

export type League = 'NFL' | 'NBA' | 'MLB' | 'ATP' | 'WTA' | 'PGA';

/** One executed trade, normalized across platforms. */
export interface NormalizedTrade {
  platform: Platform;
  tradeId: string;
  marketTicker: string;
  eventTicker: string;
  league: League;
  ts: Date;
  /** Outcome the taker bought: 'yes' or 'no'. */
  takerSide: 'yes' | 'no';
  /** Price per contract the taker paid for their side, 0–1 dollars. */
  takerPrice: number;
  /** YES price of the trade, 0–1 dollars (for charting a single price line). */
  yesPrice: number;
  contracts: number;
  /** contracts × takerPrice — dollars the taker put at risk. */
  notionalUsd: number;
  isBlockTrade: boolean;
}

export interface MarketMeta {
  platform: Platform;
  marketTicker: string;
  eventTicker: string;
  seriesTicker: string;
  league: League;
  title: string | null;
  /** Team / player this market's YES resolves on, when the platform says. */
  yesSubTitle: string | null;
  openTime: Date | null;
  closeTime: Date | null;
  result: string | null;
}
