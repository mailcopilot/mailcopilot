import type {
  FolderCrawlState,
  MessageRow,
  SearchCoverageStats,
  SearchIndexStats,
} from '../../packages/db'

export type SearchSort = 'relevance' | 'date'

export type SearchWorkerRequestMap = {
  'cache:search': { accountId: number; folder: string; query: string; limit: number; offset: number; sort: SearchSort }
  'cache:unifiedSearch': { accountIds: number[]; query: string; limit: number; offset: number; scope: 'inbox' | 'all'; sort: SearchSort }
  'search:indexStats': { accountIds: number[] }
  'search:coverageStats': { accountIds: number[] }
  'search:crawlStates': { accountIds: number[] }
  shutdown: null
}

export type SearchWorkerResultMap = {
  'cache:search': MessageRow[]
  'cache:unifiedSearch': MessageRow[]
  'search:indexStats': SearchIndexStats
  'search:coverageStats': SearchCoverageStats
  'search:crawlStates': FolderCrawlState[]
  shutdown: null
}

export type SearchWorkerRequestType = keyof SearchWorkerRequestMap

export type SearchWorkerRequest<T extends SearchWorkerRequestType = SearchWorkerRequestType> = {
  [K in SearchWorkerRequestType]: {
    id: number
    type: K
    payload: SearchWorkerRequestMap[K]
  }
}[T]

export type SearchWorkerSuccessResponse<T extends SearchWorkerRequestType = SearchWorkerRequestType> = {
  id: number
  ok: true
  result: SearchWorkerResultMap[T]
}

export type SearchWorkerFailureResponse = {
  id: number
  ok: false
  error: string
}

export type SearchWorkerResponse<T extends SearchWorkerRequestType = SearchWorkerRequestType> =
  | SearchWorkerSuccessResponse<T>
  | SearchWorkerFailureResponse
