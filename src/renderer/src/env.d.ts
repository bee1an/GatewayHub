/// <reference types="vite/client" />

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
