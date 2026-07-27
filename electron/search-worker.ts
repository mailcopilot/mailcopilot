import { parentPort } from 'node:worker_threads'
import {
  closeSearchReadOnlyDb,
  getSearchCoverageStatsReadOnly,
  getSearchIndexStatsReadOnly,
  listFolderCrawlStatesReadOnly,
  searchMessagesReadOnly,
  searchUnifiedInboxReadOnly,
} from './services/searchReadonlyDb'
import type { SearchWorkerRequest, SearchWorkerResponse } from './services/searchProtocol'

function serializeError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
  return String(error)
}

function postMessage(message: SearchWorkerResponse): void {
  parentPort?.postMessage(message)
}

function handleRequest(message: SearchWorkerRequest): void {
  try {
    switch (message.type) {
      case 'cache:search':
        postMessage({
          id: message.id,
          ok: true,
          result: searchMessagesReadOnly(
            message.payload.accountId,
            message.payload.folder,
            message.payload.query,
            message.payload.limit,
            message.payload.offset,
            message.payload.sort,
          ),
        })
        return
      case 'cache:unifiedSearch':
        postMessage({
          id: message.id,
          ok: true,
          result: searchUnifiedInboxReadOnly(
            message.payload.accountIds,
            message.payload.query,
            message.payload.limit,
            message.payload.offset,
            message.payload.scope,
            message.payload.sort,
          ),
        })
        return
      case 'search:indexStats':
        postMessage({
          id: message.id,
          ok: true,
          result: getSearchIndexStatsReadOnly(message.payload.accountIds),
        })
        return
      case 'search:coverageStats':
        postMessage({
          id: message.id,
          ok: true,
          result: getSearchCoverageStatsReadOnly(message.payload.accountIds),
        })
        return
      case 'search:crawlStates':
        postMessage({
          id: message.id,
          ok: true,
          result: listFolderCrawlStatesReadOnly(message.payload.accountIds),
        })
        return
      case 'shutdown':
        closeSearchReadOnlyDb()
        parentPort?.close()
        return
    }
  } catch (error) {
    postMessage({ id: message.id, ok: false, error: serializeError(error) })
  }
}

parentPort?.on('message', handleRequest)
