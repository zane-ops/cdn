// src/types.ts

// For /api/stats
export interface StatsResponse {
  total: number;
}

// For /api/releases
export interface ReleaseItem {
  tag: string;
  url: string;
}
export type ReleasesResponse = ReleaseItem[];

// For /api/latest-release
export interface LatestReleaseResponse {
  tag: string;
  url: string;
}

// For /api/ping (POST request response)
export interface PingResponse {
  success: boolean;
  message: string;
}

// For /api/pings
export interface PingRecord {
  ip_hmac: string; // Assuming ip_hmac is a string from the DB
  ping_timestamp: string; // ISO date string
}
export type PingsResponse = PingRecord[];

// For /api/stats/summary
export interface MostActiveUser {
  ipHmac: string;
  pingCount: number;
}
export interface SummaryStatsResponse {
  totalPings: number;
  totalUniqueUsers: number;
  mostActiveUser: MostActiveUser | null;
}

// For /api/pings/grouped
export type PeriodOption = '24h' | '7d' | '30d' | '6month' | 'all';
export type CountTypeOption = 'unique' | 'total';
export interface GroupedPing {
  day: string; // YYYY-MM-DD
  count: number;
}
export type GroupedPingsResponse = GroupedPing[];

// For /api/pings/unique-activity
export type SortByOption = 'first_seen' | 'total_pings';
export type SortOrderOption = 'asc' | 'desc';
export interface UniqueActivityRecord {
  ip_hmac: string;
  first_seen: string; // ISO date string
  last_seen: string; // ISO date string
  total_pings: number;
}
export interface PaginationInfo {
  totalItems: number;
  currentPage: number;
  pageSize: number;
  totalPages: number;
}
export interface UniqueActivityResponse {
  data: UniqueActivityRecord[];
  pagination: PaginationInfo;
}

// General type for query parameters of /api/stats/summary & /api/pings/grouped
export interface PeriodQueryParams {
  period?: PeriodOption;
}

// General type for query parameters of /api/pings/grouped
export interface GroupedPingsQueryParams extends PeriodQueryParams {
  countType?: CountTypeOption;
}

// General type for query parameters of /api/pings/unique-activity
export interface UniqueActivityQueryParams {
  page?: string; // Parsed to number later
  pageSize?: string; // Parsed to number later
  sortBy?: SortByOption;
  sortOrder?: SortOrderOption;
}
