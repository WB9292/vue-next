import {
  isArray,
  isOn,
  hasOwn,
  EMPTY_OBJ,
  capitalize,
  hyphenate,
  isFunction,
  extend,
  camelize
} from '@vue/shared'
import {
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  formatComponentName
} from './component'
import { callWithAsyncErrorHandling, ErrorCodes } from './errorHandling'
import { warn } from './warning'
import { UnionToIntersection } from './helpers/typeUtils'
import { devtoolsComponentEmit } from './devtools'
import { AppContext } from './apiCreateApp'

export type ObjectEmitsOptions = Record<
  string,
  ((...args: any[]) => any) | null
>
export type EmitsOptions = ObjectEmitsOptions | string[]

export type EmitFn<
  Options = ObjectEmitsOptions,
  Event extends keyof Options = keyof Options
> = Options extends Array<infer V>
  ? (event: V, ...args: any[]) => void
  : {} extends Options // if the emit is empty object (usually the default value for emit) should be converted to function
    ? (event: string, ...args: any[]) => void
    : UnionToIntersection<
        {
          [key in Event]: Options[key] extends ((...args: infer Args) => any)
            ? (event: key, ...args: Args) => void
            : (event: key, ...args: any[]) => void
        }[Event]
      >

export function emit(
  instance: ComponentInternalInstance,
  event: string,
  ...args: any[]
) {
  const props = instance.vnode.props || EMPTY_OBJ

  if (__DEV__) {
    const {
      emitsOptions,
      propsOptions: [propsOptions]
    } = instance
    if (emitsOptions) {
      if (!(event in emitsOptions)) {
        if (!propsOptions || !(`on` + capitalize(event) in propsOptions)) {
          warn(
            `Component emitted event "${event}" but it is neither declared in ` +
              `the emits option nor as an "on${capitalize(event)}" prop.`
          )
        }
      } else {
        const validator = emitsOptions[event]
        if (isFunction(validator)) {
          const isValid = validator(...args)
          if (!isValid) {
            warn(
              `Invalid event arguments: event validation failed for event "${event}".`
            )
          }
        }
      }
    }
  }

  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    devtoolsComponentEmit(instance, event, args)
  }

  if (__DEV__) {
    const lowerCaseEvent = event.toLowerCase()
    if (lowerCaseEvent !== event && props[`on` + capitalize(lowerCaseEvent)]) {
      warn(
        `Event "${lowerCaseEvent}" is emitted in component ` +
          `${formatComponentName(
            instance,
            instance.type
          )} but the handler is registered for "${event}". ` +
          `Note that HTML attributes are case-insensitive and you cannot use ` +
          `v-on to listen to camelCase events when using in-DOM templates. ` +
          `You should probably use "${hyphenate(event)}" instead of "${event}".`
      )
    }
  }

  // convert handler name to camelCase. See issue #2249
  let handlerName = `on${capitalize(camelize(event))}`
  let handler = props[handlerName]
  // for v-model update:xxx events, also trigger kebab-case equivalent
  // for props passed via kebab-case
  if (!handler && event.startsWith('update:')) {
    handlerName = `on${capitalize(hyphenate(event))}`
    handler = props[handlerName]
  }
  if (!handler) {
    handler = props[handlerName + `Once`]
    if (!instance.emitted) {
      ;(instance.emitted = {} as Record<string, boolean>)[handlerName] = true
    } else if (instance.emitted[handlerName]) {
      return
    }
  }
  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }
}

/**
 * emits是Vue3支持的新特性，用于声明当前组件会触发的事件。
 * 该方法用于标准化emits的值
 * 个人理解：emits的作用主要有：
 * 1）对触发事件的参数进行校验，Todo 如果校验不通过，会怎么做？不触发事件？
 * 2）更加清晰的显示当前组件会触发的事件。（个人猜测，^_^）
 * @param comp
 * @param appContext
 * @param asMixin
 */
export function normalizeEmitsOptions(
  comp: ConcreteComponent,
  appContext: AppContext,
  asMixin = false
): ObjectEmitsOptions | null {
  // 如果已经标准化，则无需再标准化
  if (!appContext.deopt && comp.__emits !== undefined) {
    return comp.__emits
  }

  const raw = comp.emits
  let normalized: ObjectEmitsOptions = {}

  // apply mixin/extends props
  let hasExtends = false
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    const extendEmits = (raw: ComponentOptions) => {
      hasExtends = true
      extend(normalized, normalizeEmitsOptions(raw, appContext, true))
    }
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits)
    }
    if (comp.extends) {
      extendEmits(comp.extends)
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits)
    }
  }

  if (!raw && !hasExtends) {
    return (comp.__emits = null)
  }

  if (isArray(raw)) {
    raw.forEach(key => (normalized[key] = null))
  } else {
    extend(normalized, raw)
  }
  return (comp.__emits = normalized)
}

// Check if an incoming prop key is a declared emit event listener.
// e.g. With `emits: { click: null }`, props named `onClick` and `onclick` are
// both considered matched listeners.
// 如上所述，支持onClick和onclick形式的事件监听，所以这个方法用于判断key是否为onclick或onClick形式的键，而不是@click形式的特性
export function isEmitListener(
  options: ObjectEmitsOptions | null,
  key: string
): boolean {
  if (!options || !isOn(key)) {
    return false
  }
  // Todo 为什么要把Once替换为''，Once哪来的？
  key = key.replace(/Once$/, '')
  return (
    hasOwn(options, key[2].toLowerCase() + key.slice(3)) ||
    hasOwn(options, key.slice(2))
  )
}
