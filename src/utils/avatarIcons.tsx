import type { ComponentType } from 'react'
import {
  Mail, Briefcase, Building2, GraduationCap, Heart,
  Star, Zap, Globe, Rocket, Shield,
  Coffee, Music, Camera, Gamepad2, Palette, Code,
  AtSign,
} from 'lucide-react'

// ---- Custom brand-style SVG icons (stroke-based, lucide-compatible) ----
/* eslint-disable react-refresh/only-export-components */

interface IconProps { size?: number | string }

/** Google-style "G" icon. */
function GoogleG({ size = 24 }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.5 12H19A7 7 0 1 1 17 7" />
    </svg>
  )
}

/** Yandex-style "Y" icon. */
function YandexY({ size = 24 }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l6 8M18 4l-6 8v8" />
    </svg>
  )
}

// ---- Icon registry ----

/** Component type for avatar icons (lucide or custom). */
type AvatarIconComponent = ComponentType<{ size?: number | string }>

/** List of available preset icons for account avatars. */
export const AVATAR_ICONS = [
  'mail', 'briefcase', 'building-2', 'graduation-cap', 'heart',
  'star', 'zap', 'globe', 'rocket', 'shield',
  'coffee', 'music', 'camera', 'gamepad-2', 'palette', 'code',
  'at-sign', 'google', 'yandex',
] as const

export type AvatarIconName = typeof AVATAR_ICONS[number]

const ICON_MAP: Record<AvatarIconName, AvatarIconComponent> = {
  'mail': Mail,
  'briefcase': Briefcase,
  'building-2': Building2,
  'graduation-cap': GraduationCap,
  'heart': Heart,
  'star': Star,
  'zap': Zap,
  'globe': Globe,
  'rocket': Rocket,
  'shield': Shield,
  'coffee': Coffee,
  'music': Music,
  'camera': Camera,
  'gamepad-2': Gamepad2,
  'palette': Palette,
  'code': Code,
  'at-sign': AtSign,
  'google': GoogleG,
  'yandex': YandexY,
}

/** Returns the avatar icon component by name. Falls back to Mail if not found. */
export function getAvatarIcon(name: string): AvatarIconComponent {
  return ICON_MAP[name as AvatarIconName] ?? Mail
}
