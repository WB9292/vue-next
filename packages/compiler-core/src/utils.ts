import {
  SourceLocation,
  Position,
  ElementNode,
  NodeTypes,
  CallExpression,
  createCallExpression,
  DirectiveNode,
  ElementTypes,
  TemplateChildNode,
  RootNode,
  ObjectExpression,
  Property,
  JSChildNode,
  createObjectExpression,
  SlotOutletNode,
  TemplateNode,
  RenderSlotCall,
  ExpressionNode,
  IfBranchNode,
  TextNode,
  InterpolationNode,
  VNodeCall,
  SimpleExpressionNode
} from './ast'
import { TransformContext } from './transform'
import {
  MERGE_PROPS,
  TELEPORT,
  SUSPENSE,
  KEEP_ALIVE,
  BASE_TRANSITION
} from './runtimeHelpers'
import { isString, isObject, hyphenate, extend } from '@vue/shared'

export const isStaticExp = (p: JSChildNode): p is SimpleExpressionNode =>
  p.type === NodeTypes.SIMPLE_EXPRESSION && p.isStatic

export const isBuiltInType = (tag: string, expected: string): boolean =>
  tag === expected || tag === hyphenate(expected)

export function isCoreComponent(tag: string): symbol | void {
  if (isBuiltInType(tag, 'Teleport')) {
    return TELEPORT
  } else if (isBuiltInType(tag, 'Suspense')) {
    return SUSPENSE
  } else if (isBuiltInType(tag, 'KeepAlive')) {
    return KEEP_ALIVE
  } else if (isBuiltInType(tag, 'BaseTransition')) {
    return BASE_TRANSITION
  }
}

const nonIdentifierRE = /^\d|[^\$\w]/
export const isSimpleIdentifier = (name: string): boolean =>
  !nonIdentifierRE.test(name)

const memberExpRE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*$/
// Todo 应该是"hello"、"hello.world"、"hello[world]"形式的字符串吧，暂不研究
export const isMemberExpression = (path: string): boolean => {
  if (!path) return false
  return memberExpRE.test(path.trim())
}

/**
 * 以loc为参考点，生成一个新的SourceLocation，该新值是以offset为偏移量，以length为长度的新位置
 * @param loc
 * @param offset
 * @param length
 */
export function getInnerRange(
  loc: SourceLocation,
  offset: number,
  length?: number
): SourceLocation {
  __TEST__ && assert(offset <= loc.source.length)
  const source = loc.source.substr(offset, length)
  const newLoc: SourceLocation = {
    source,
    start: advancePositionWithClone(loc.start, loc.source, offset),
    end: loc.end
  }

  if (length != null) {
    __TEST__ && assert(offset + length <= loc.source.length)
    newLoc.end = advancePositionWithClone(
      loc.start,
      loc.source,
      offset + length
    )
  }

  return newLoc
}

/**
 * 根据pos创建一个新的位置对象，根据source和numberOfCharacters向前移动
 * @param pos
 * @param source
 * @param numberOfCharacters
 */
export function advancePositionWithClone(
  pos: Position,
  source: string,
  numberOfCharacters: number = source.length
): Position {
  return advancePositionWithMutation(
    extend({}, pos),
    source,
    numberOfCharacters
  )
}

// advance by mutation without cloning (for performance reasons), since this
// gets called a lot in the parser
/**
 * 该方法用于更新pos的位置信息
 * @param pos
 * @param source
 * @param numberOfCharacters 前进的字符个数
 */
export function advancePositionWithMutation(
  pos: Position,
  source: string,
  numberOfCharacters: number = source.length
): Position {
  // 前进时，有多少换行
  let linesCount = 0
  // lastNewLinePos表示最后一个换行符\n之后剩余的字符数
  // 以"a\nbc"为例，要跳过这四个字符，当source.charCodeAt(i) === 10成立时，i = 1，
  // 此时lastNewLinePos = 1，最终pos.column = numberOfCharacters - lastNewLinePos = 3，
  // 也就是当前行待处理字符的偏移量，注意，line和column都是1开始计数，而不是0
  let lastNewLinePos = -1
  for (let i = 0; i < numberOfCharacters; i++) {
    if (source.charCodeAt(i) === 10 /* newline char code */) { // '\n'.charCodeAt(0)是10
      linesCount++
      lastNewLinePos = i
    }
  }

  pos.offset += numberOfCharacters
  pos.line += linesCount
  pos.column =
    lastNewLinePos === -1
      ? pos.column + numberOfCharacters
      : numberOfCharacters - lastNewLinePos

  return pos
}

export function assert(condition: boolean, msg?: string) {
  /* istanbul ignore if */
  if (!condition) {
    throw new Error(msg || `unexpected compiler condition`)
  }
}

// 在元素节点node中查找name对应的指令节点
export function findDir(
  node: ElementNode,
  name: string | RegExp,
  allowEmpty: boolean = false
): DirectiveNode | undefined {
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    if (
      p.type === NodeTypes.DIRECTIVE &&
      (allowEmpty || p.exp) &&
      (isString(name) ? p.name === name : name.test(p.name))
    ) {
      return p
    }
  }
}

export function findProp(
  node: ElementNode,
  name: string,
  dynamicOnly: boolean = false,
  allowEmpty: boolean = false
): ElementNode['props'][0] | undefined {
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (dynamicOnly) continue
      if (p.name === name && (p.value || allowEmpty)) {
        return p
      }
    } else if (
      p.name === 'bind' &&
      (p.exp || allowEmpty) &&
      isBindKey(p.arg, name)
    ) {
      return p
    }
  }
}

export function isBindKey(arg: DirectiveNode['arg'], name: string): boolean {
  return !!(arg && isStaticExp(arg) && arg.content === name)
}

export function hasDynamicKeyVBind(node: ElementNode): boolean {
  return node.props.some(
    p =>
      p.type === NodeTypes.DIRECTIVE &&
      p.name === 'bind' &&
      (!p.arg || // v-bind="obj"
      p.arg.type !== NodeTypes.SIMPLE_EXPRESSION || // v-bind:[_ctx.foo]
        !p.arg.isStatic) // v-bind:[foo]
  )
}

export function isText(
  node: TemplateChildNode
): node is TextNode | InterpolationNode {
  return node.type === NodeTypes.INTERPOLATION || node.type === NodeTypes.TEXT
}

export function isVSlot(p: ElementNode['props'][0]): p is DirectiveNode {
  return p.type === NodeTypes.DIRECTIVE && p.name === 'slot'
}

export function isTemplateNode(
  node: RootNode | TemplateChildNode
): node is TemplateNode {
  return (
    node.type === NodeTypes.ELEMENT && node.tagType === ElementTypes.TEMPLATE
  )
}

// 是否是插槽元素<slot>
export function isSlotOutlet(
  node: RootNode | TemplateChildNode
): node is SlotOutletNode {
  return node.type === NodeTypes.ELEMENT && node.tagType === ElementTypes.SLOT
}

/**
 * Todo 猜测：该方法应该是将prop插入node的属性列表中
 * @param node
 * @param prop
 * @param context
 */
export function injectProp(
  node: VNodeCall | RenderSlotCall,
  prop: Property,
  context: TransformContext
) {
  let propsWithInjection: ObjectExpression | CallExpression
  const props =
    node.type === NodeTypes.VNODE_CALL ? node.props : node.arguments[2] // Todo node.arguments[]的第三个参数是什么？
  // Todo 难道标签上的prop只有字符串、JS_OBJECT_EXPRESSION、JS_OBJECT_EXPRESSION或单个v-bind绑定的表达式？单个v-bind绑定的表达式是什么类型？
  if (props == null || isString(props)) {
    propsWithInjection = createObjectExpression([prop])
  } else if (props.type === NodeTypes.JS_CALL_EXPRESSION) {
    // merged props... add ours
    // only inject key to object literal if it's the first argument so that
    // if doesn't override user provided keys
    const first = props.arguments[0] as string | JSChildNode
    if (!isString(first) && first.type === NodeTypes.JS_OBJECT_EXPRESSION) {
      first.properties.unshift(prop)
    } else {
      props.arguments.unshift(createObjectExpression([prop]))
    }
    propsWithInjection = props
  } else if (props.type === NodeTypes.JS_OBJECT_EXPRESSION) {
    let alreadyExists = false
    // check existing key to avoid overriding user provided keys
    if (prop.key.type === NodeTypes.SIMPLE_EXPRESSION) { // Todo 这个不知道什么逻辑
      const propKeyName = prop.key.content
      alreadyExists = props.properties.some(
        p =>
          p.key.type === NodeTypes.SIMPLE_EXPRESSION &&
          p.key.content === propKeyName
      )
    }
    if (!alreadyExists) {
      props.properties.unshift(prop)
    }
    propsWithInjection = props
  } else {
    // single v-bind with expression, return a merged replacement
    propsWithInjection = createCallExpression(context.helper(MERGE_PROPS), [
      createObjectExpression([prop]),
      props
    ])
  }
  if (node.type === NodeTypes.VNODE_CALL) {
    node.props = propsWithInjection
  } else {
    node.arguments[2] = propsWithInjection
  }
}

export function toValidAssetId(
  name: string,
  type: 'component' | 'directive'
): string {
  return `_${type}_${name.replace(/[^\w]/g, '_')}`
}

// Check if a node contains expressions that reference current context scope ids
export function hasScopeRef(
  node: TemplateChildNode | IfBranchNode | ExpressionNode | undefined,
  ids: TransformContext['identifiers']
): boolean {
  if (!node || Object.keys(ids).length === 0) {
    return false
  }
  switch (node.type) {
    case NodeTypes.ELEMENT:
      for (let i = 0; i < node.props.length; i++) {
        const p = node.props[i]
        if (
          p.type === NodeTypes.DIRECTIVE &&
          (hasScopeRef(p.arg, ids) || hasScopeRef(p.exp, ids))
        ) {
          return true
        }
      }
      return node.children.some(c => hasScopeRef(c, ids))
    case NodeTypes.FOR:
      if (hasScopeRef(node.source, ids)) {
        return true
      }
      return node.children.some(c => hasScopeRef(c, ids))
    case NodeTypes.IF:
      return node.branches.some(b => hasScopeRef(b, ids))
    case NodeTypes.IF_BRANCH:
      if (hasScopeRef(node.condition, ids)) {
        return true
      }
      return node.children.some(c => hasScopeRef(c, ids))
    case NodeTypes.SIMPLE_EXPRESSION:
      return (
        !node.isStatic &&
        isSimpleIdentifier(node.content) &&
        !!ids[node.content]
      )
    case NodeTypes.COMPOUND_EXPRESSION:
      return node.children.some(c => isObject(c) && hasScopeRef(c, ids))
    case NodeTypes.INTERPOLATION:
    case NodeTypes.TEXT_CALL:
      return hasScopeRef(node.content, ids)
    case NodeTypes.TEXT:
    case NodeTypes.COMMENT:
      return false
    default:
      if (__DEV__) {
        const exhaustiveCheck: never = node
        exhaustiveCheck
      }
      return false
  }
}
