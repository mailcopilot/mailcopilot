// Re-export from @mailcopilot/core — source of truth is packages/core/threading.ts
export {
  buildThreadRows,
  countSelectedRows,
  firstSelectedRow,
  leadKeyOfRowContaining,
  pickThreadOpenTarget,
  rowContaining,
  rowIsSelected,
  rowLeadKeyFor,
  singleMessageRow,
  toggleRowSelection,
  type RowSelectionToggle,
  type ThreadRow,
} from '@mailcopilot/core'
