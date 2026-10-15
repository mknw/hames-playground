import type { AttributifyAttributes } from '@unocss/preset-attributify'

declare module 'solid-js' {
  namespace JSX {
    interface HTMLAttributes<T> extends AttributifyAttributes {
      whitespace?: string | boolean
      inset?: string | boolean
      tracking?: string | boolean
      leading?: string | boolean
    }
    interface SVGAttributes<T> extends AttributifyAttributes {
      tracking?: string | boolean
      leading?: string | boolean
    }
  }
}
