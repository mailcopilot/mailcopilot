import { Inbox, Send, FileText, Trash2, ShieldAlert, Archive, Folder } from 'lucide-react'

export default function FolderIcon({ role, size = 18, customIcon }: { role: string | null; size?: number; customIcon?: string }) {
  const icon = (customIcon || '').trim()
  if (icon) {
    return <span className="folder-custom-icon" style={{ fontSize: size }}>{icon}</span>
  }
  switch (role) {
    case '\\Inbox': return <Inbox size={size} />
    case '\\Sent': return <Send size={size} />
    case '\\Drafts': return <FileText size={size} />
    case '\\Trash': return <Trash2 size={size} />
    case '\\Junk': return <ShieldAlert size={size} />
    case '\\Archive': return <Archive size={size} />
    default: return <Folder size={size} />
  }
}
