/// <reference types="vite/client" />

declare module '@radix-ui/react-tooltip' {
  import * as React from 'react'
  type Side = 'top' | 'right' | 'bottom' | 'left'
  export const Provider: React.FC<{
    delayDuration?: number
    disableHoverableContent?: boolean
    children?: React.ReactNode
  }>
  export const Root: React.FC<{ children?: React.ReactNode }>
  export const Trigger: React.FC<{ asChild?: boolean; children?: React.ReactNode }>
  export const Portal: React.FC<{ children?: React.ReactNode }>
  export const Content: React.FC<{
    side?: Side
    sideOffset?: number
    className?: string
    children?: React.ReactNode
  }>
  export const Arrow: React.FC<{ className?: string }>
}

declare module '@radix-ui/react-tabs' {
  import * as React from 'react'
  export const Root: React.FC<{
    value?: string
    defaultValue?: string
    onValueChange?: (value: string) => void
    className?: string
    children?: React.ReactNode
  }>
  export const List: React.FC<{ className?: string; children?: React.ReactNode }>
  export const Trigger: React.FC<{ value: string; className?: string; children?: React.ReactNode }>
  export const Content: React.FC<{ value: string; className?: string; children?: React.ReactNode }>
}
